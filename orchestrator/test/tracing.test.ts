// Phase 1: tool-call spans, metrics, the internal /metrics route, and trace propagation
// (header + params._meta.traceparent) to the instance.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { buildServer } from '../src/server.ts';
import { buildInternalServer } from '../src/internal-server.ts';
import { InstanceClient } from '../src/instance-client.ts';
import { instrumentProvider } from '../src/instrument-provider.ts';
import { Metrics } from '../src/metrics.ts';
import type { ToolDef } from '../src/mcp.ts';
import { generateId, type Computer, type Provider } from '../src/providers/types.ts';

const exporter = new InMemorySpanExporter();
const tp = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const cm = new AsyncLocalStorageContextManager().enable();

const PSK = 'psk';
const catalog: ToolDef[] = [{ name: 'click', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }];

let seen: Array<{ method: string; traceparent?: string; meta?: any }> = [];
let inst: FastifyInstance, app: FastifyInstance, base: string, instUrl: string;
const metrics = new Metrics({ defaultMetrics: false });

function memoryProvider(url: string): Provider {
  const all = new Map<string, Computer>();
  return {
    scheme: 'memory',
    async list(owner) { return [...all.values()].filter((c) => c.owner === owner); },
    async listAll() { return [...all.values()]; },
    async get(id) { return all.get(id) ?? null; },
    async create({ owner }) {
      const c: Computer = { id: generateId(), owner: owner.id, status: 'running', stopped: false, internalUrl: url, token: 't' };
      all.set(c.id, c);
      return c;
    },
    async start(id) { return all.get(id)!; },
    async destroy(id) { all.delete(id); },
  };
}

async function tool(name: string, args: object, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${PSK}`, 'x-ozwell-user-id': 'alice', 'x-ozwell-user-email': 'alice@example.com', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const data = (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  const res = JSON.parse(data).result;
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}

const byName = (n: string) => exporter.getFinishedSpans().filter((s) => s.name === n);
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

beforeAll(async () => {
  context.setGlobalContextManager(cm);
  trace.setGlobalTracerProvider(tp);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  inst = Fastify();
  inst.post('/mcp', async (req, reply) => {
    const m = req.body as any;
    seen.push({ method: m.method, traceparent: req.headers.traceparent as string | undefined, meta: m.params?._meta });
    if (m.method === 'initialize') return reply.header('mcp-session-id', 's1').send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } });
    if (!m.id) return reply.code(202).send();
    return reply.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  });
  inst.get('/health', async (_r, reply) => reply.code(204).send());
  await inst.listen({ port: 0, host: '127.0.0.1' });
  instUrl = `http://127.0.0.1:${(inst.server.address() as any).port}`;

  const provider = instrumentProvider(memoryProvider(instUrl), metrics.onProviderCall);
  app = await buildServer({ provider, catalog, client: new InstanceClient(), version: 't', psk: PSK, readyTimeoutMs: 5000, metrics });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
});
afterAll(async () => {
  await app.close(); await inst.close(); await tp.shutdown();
  trace.disable(); context.disable(); propagation.disable();
});
beforeEach(() => { exporter.reset(); seen = []; });

describe('tool-call tracing', () => {
  it('nests provider, readiness and instance spans under the tool-call span', async () => {
    const created = await tool('create_computer', {});
    expect(created.data.ready).toBe(true);
    const [create] = byName('mcp.tools/call create_computer');
    expect(create.attributes).toMatchObject({ 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'create_computer', 'enduser.id': 'alice@example.com', 'ozwell.provider': 'memory', 'ozwell.ready': true });
    const [pcreate] = byName('provider.create');
    expect(parentOf(pcreate)).toBe(create.spanContext().spanId);
    const [poll] = byName('readiness.poll');
    expect(parentOf(poll)).toBe(create.spanContext().spanId);
    expect(poll.events[0].name).toBe('attempt');

    exporter.reset();
    const id = created.data.instance_id;
    expect((await tool('click', { instance_id: id, x: 3 })).data).toEqual({ ok: true });
    const [call] = byName('mcp.tools/call click');
    expect(call.attributes['ozwell.instance_id']).toBe(id);
    expect(JSON.parse(call.attributes['ozwell.tool.arguments'] as string)).toEqual({ instance_id: id, x: 3 });
    const [ic] = byName('instance.callTool');
    expect(parentOf(ic)).toBe(call.spanContext().spanId);

    // traceparent reached the instance, as a header and in params._meta, in the same trace.
    const tc = seen.find((s) => s.method === 'tools/call')!;
    const traceId = call.spanContext().traceId;
    expect(tc.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(tc.meta.traceparent).toMatch(new RegExp(`^00-${traceId}-`));
  });

  it('continues an incoming traceparent and marks error results', async () => {
    const parent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const r = await tool('get_computer', { instance_id: 'nope' }, { traceparent: parent });
    expect(r.isError).toBe(true);
    const [s] = byName('mcp.tools/call get_computer');
    expect(s.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(s.status.code).toBe(2);
    expect(s.attributes['error.type']).toBe('target_unavailable');
  });
});

describe('internal /metrics', () => {
  it('serves tool-call and provider metrics with trace exemplars', async () => {
    await tool('list_computers', {});
    const internal = await buildInternalServer({ metrics });
    try {
      const r = await internal.inject({ method: 'GET', url: '/metrics' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/openmetrics/);
      expect(r.body).toMatch(/ozwell_orchestrator_tool_calls_total\{tool="list_computers",outcome="ok"\} \d/);
      expect(r.body).toMatch(/ozwell_orchestrator_tool_calls_total\{tool="get_computer",outcome="error"\} 1/);
      expect(r.body).toMatch(/ozwell_orchestrator_provider_call_duration_seconds_count\{provider="memory",method="list",outcome="ok"\}/);
      expect(r.body).toMatch(/ozwell_orchestrator_tool_call_duration_seconds_bucket\{[^}]*\} \d+ # \{trace_id="[0-9a-f]{32}"\}/);
      expect((await internal.inject({ method: 'GET', url: '/health' })).statusCode).toBe(204);
    } finally {
      await internal.close();
    }
  });
});
