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
import { readFileSync } from 'node:fs';
import { Metrics, TOOL_ERROR_REASONS } from '../src/metrics.ts';
import { LogPuller } from '../src/log-puller.ts';
import { OperationTracker } from '../src/operations.ts';
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
  let body: any; try { body = JSON.parse(res.content[0].text); } catch { body = res.content[0].text; }
  return { isError: !!res.isError, data: body };
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
    // Errors as computers report them, chosen by x (tool-call error reasons).
    const err = (text: string) => reply.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], isError: true } });
    const rpcErr = (code: number) => reply.send({ jsonrpc: '2.0', id: m.id, error: { code, message: `rpc ${code}` } });
    switch (m.params?.arguments?.x) {
      case -1: return err('MCP error -32602: Input validation error: Invalid arguments for tool click: x');
      case -2: return err('{"error":{"reason":"path_not_found","message":"no such file"}}');
      case -3: return rpcErr(-32602);
      case -4: return rpcErr(-32603);
      case -5: return err('something unexpected');
      case -6: return err('{"error":{"reason":"brand_new_reason","message":"?"}}');
    }
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

describe('background work is not traced', () => {
  it('creates no spans for the log puller or the readiness watcher, but operations still trace', async () => {
    const provider = instrumentProvider(memoryProvider(instUrl));
    const c = await provider.create({ owner: { id: 'zed' } });
    exporter.reset();
    const puller = new LogPuller({ provider, shipUrl: 'http://127.0.0.1:1/insert/journald/upload', discoverMs: 0 });
    await puller.tick();
    const ops = new OperationTracker({ provider: 'memory', probe: async (id) => ({ c: await provider.get(id), ready: true }) });
    const op = ops.begin('start', c.id);
    op.enqueued({ ...c, stopped: true });
    await ops.pollOnce();
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(['operation.start']); // no provider.listAll/get, no HTTP client spans
    expect(exporter.getFinishedSpans()[0].attributes['ozwell.kind']).toBe('operation');
  });
});

describe('tool-call error reasons', () => {
  it('labels tool_calls_total with a fixed set of reasons', async () => {
    const m = new Metrics({ defaultMetrics: false });
    m.observeToolCall('click', 'ok', 0.1);
    m.observeToolCall('click', 'error', 0.1, 'invalid_request');
    m.observeToolCall('click', 'error', 0.1, 'computer_stopped');
    m.observeToolCall('click', 'error', 0.1, 'stale_handle'); // a computer's own reason, passed through
    m.observeToolCall('click', 'error', 0.1, 'brand_new_reason'); // unknown: other
    m.observeToolCall('click', 'error', 0.1, 'tool_error');
    m.observeToolCall('click', 'error', 0.1); // no reason: an unexpected failure
    const body = await m.registry.metrics();
    expect(body).toContain('ozwell_orchestrator_tool_calls_total{tool="click",outcome="ok",reason="none"} 1');
    expect(body).toContain('ozwell_orchestrator_tool_calls_total{tool="click",outcome="error",reason="invalid_request"} 1');
    expect(body).toContain('ozwell_orchestrator_tool_calls_total{tool="click",outcome="error",reason="computer_stopped"} 1');
    expect(body).toContain('ozwell_orchestrator_tool_calls_total{tool="click",outcome="error",reason="stale_handle"} 1');
    expect(body).toContain('ozwell_orchestrator_tool_calls_total{tool="click",outcome="error",reason="other"} 2');
    expect(body).toContain('ozwell_orchestrator_tool_calls_total{tool="click",outcome="error",reason="internal"} 1');
    expect(body).not.toContain('brand_new_reason');
  });

  it('passes through every reason a computer can return (src/errors.ts)', () => {
    const src = readFileSync(new URL('../../src/errors.ts', import.meta.url), 'utf8');
    const union = /export type Reason =([^;]+);/.exec(src)![1];
    const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(5);
    for (const r of reasons) expect(TOOL_ERROR_REASONS).toContain(r);
  });

  it('labels computers\' errors by reason; only real failures are internal', async () => {
    const id = (await tool('create_computer', {})).data.instance_id;
    const count = async (reason: string) => (await metrics.registry.getSingleMetric('ozwell_orchestrator_tool_calls_total')!.get())
      .values.find((v) => v.labels.tool === 'click' && v.labels.reason === reason)?.value ?? 0;
    const counted = async (x: number, reason: string) => {
      const before = await count(reason);
      expect((await tool('click', { instance_id: id, x })).isError).toBe(true);
      return (await count(reason)) - before;
    };
    expect(await counted(-1, 'invalid_request')).toBe(1); // the SDK's input validation error
    expect(await counted(-2, 'path_not_found')).toBe(1);
    expect(await counted(-3, 'invalid_request')).toBe(1); // JSON-RPC invalid params
    expect(await counted(-4, 'internal')).toBe(1); // JSON-RPC internal error
    expect(await counted(-5, 'other')).toBe(1); // unrecognised error text
    expect(await counted(-6, 'other')).toBe(1);
  });

  it('counts an unknown tool as invalid_request', async () => {
    expect((await tool('no_such_tool', {})).isError).toBe(true);
    expect(await metrics.registry.metrics()).toContain('ozwell_orchestrator_tool_calls_total{tool="no_such_tool",outcome="error",reason="invalid_request"} 1');
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
      expect(r.body).toMatch(/ozwell_orchestrator_tool_calls_total\{tool="list_computers",outcome="ok",reason="none"\} \d/);
      expect(r.body).toMatch(/ozwell_orchestrator_tool_calls_total\{tool="get_computer",outcome="error",reason="target_unavailable"\} 1/);
      expect(r.body).toMatch(/ozwell_orchestrator_provider_call_duration_seconds_count\{provider="memory",method="list",outcome="ok"\}/);
      expect(r.body).toMatch(/ozwell_orchestrator_tool_call_duration_seconds_bucket\{[^}]*\} \d+ # \{trace_id="[0-9a-f]{32}"\}/);
      expect((await internal.inject({ method: 'GET', url: '/health' })).statusCode).toBe(204);
    } finally {
      await internal.close();
    }
  });
});
