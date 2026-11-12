// Phase 2: operation timing. Tracker units with a fake clock and probe, then create→ready
// across three tool calls through the server (one operation, linked from each call).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { OperationTracker } from '../src/operations.ts';
import { Metrics } from '../src/metrics.ts';
import { buildServer } from '../src/server.ts';
import { InstanceClient } from '../src/instance-client.ts';
import { generateId, type Computer, type Provider } from '../src/providers/types.ts';

const exporter = new InMemorySpanExporter();
const tp = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
beforeAll(() => { context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()); trace.setGlobalTracerProvider(tp); });
afterAll(async () => { await tp.shutdown(); trace.disable(); context.disable(); });
beforeEach(() => exporter.reset());

const comp = (over: Partial<Computer> = {}): Computer => ({ id: 'ozc-1', owner: 'alice', status: 'running', stopped: false, internalUrl: 'http://x', ...over });

/** Histogram sum and count for the series matching `labels`. */
async function hist(m: Metrics, name: keyof Metrics, labels: Record<string, string>) {
  const { values } = await (m[name] as any).get();
  const match = (v: any, suffix: string) => v.metricName.endsWith(suffix) && Object.entries(labels).every(([k, x]) => v.labels[k] === x);
  return { sum: values.find((v: any) => match(v, '_sum'))?.value, count: values.find((v: any) => match(v, '_count'))?.value ?? 0 };
}
const counter = async (m: Metrics, labels: Record<string, string>) =>
  (await m.operations.get()).values.find((v) => Object.entries(labels).every(([k, x]) => (v.labels as any)[k] === x))?.value ?? 0;
const inFlight = async (m: Metrics, operation: string) =>
  (await m.operationsInFlight.get()).values.find((v) => v.labels.operation === operation)?.value ?? 0;

function setup(probe: (id: string) => { c: Computer | null; ready: boolean }, timeoutMs = 600_000) {
  let now = 1_000_000;
  const metrics = new Metrics({ defaultMetrics: false });
  const tracker = new OperationTracker({ provider: 'fake', metrics, probe: async (id) => probe(id), now: () => now, timeoutMs });
  return { metrics, tracker, at: (s: number) => { now = 1_000_000 + s * 1000; } };
}

describe('OperationTracker', () => {
  it('times a create through enqueue, provision and boot', async () => {
    let state: { c: Computer | null; ready: boolean } = { c: comp({ stopped: true, internalUrl: undefined, status: 'creating' }), ready: false };
    const { metrics, tracker, at } = setup(() => state);
    const op = tracker.begin('create');
    expect(await inFlight(metrics, 'create')).toBe(1);
    at(2); op.enqueued(state.c!);
    expect(op.phase).toBe('provision');
    expect(tracker.inFlight('ozc-1')).toBe(op);

    at(5); await tracker.pollOnce();
    expect(op.phase).toBe('provision');
    state = { c: comp(), ready: false };
    at(10); await tracker.pollOnce();
    expect(op.phase).toBe('boot');
    state = { c: comp(), ready: true };
    at(25); await tracker.pollOnce();
    expect(op.outcome).toBe('ok');

    expect(await hist(metrics, 'operationDuration', { operation: 'create', outcome: 'ok' })).toEqual({ sum: 25, count: 1 });
    expect((await hist(metrics, 'operationPhase', { operation: 'create', phase: 'enqueue' })).sum).toBe(2);
    expect((await hist(metrics, 'operationPhase', { operation: 'create', phase: 'provision' })).sum).toBe(8);
    expect((await hist(metrics, 'operationPhase', { operation: 'create', phase: 'boot' })).sum).toBe(15);
    expect(await inFlight(metrics, 'create')).toBe(0);
    expect(tracker.inFlight('ozc-1')).toBeUndefined();

    const [span] = exporter.getFinishedSpans().filter((s) => s.name === 'operation.create');
    expect(span.parentSpanContext).toBeUndefined(); // its own trace
    expect(span.events.map((e) => e.name)).toEqual(['phase.provision', 'phase.boot']);
    expect(span.attributes).toMatchObject({ 'ozwell.instance_id': 'ozc-1', 'ozwell.outcome': 'ok' });
  });

  it('times out and fails dead computers', async () => {
    const { metrics, tracker, at } = setup(() => ({ c: comp({ stopped: true }), ready: false }), 60_000);
    const op = tracker.begin('start', 'ozc-1');
    op.enqueued(comp({ stopped: true }));
    at(30); await tracker.pollOnce();
    expect(op.done).toBe(false);
    at(61); await tracker.pollOnce();
    expect(op.outcome).toBe('timeout');
    expect(await counter(metrics, { operation: 'start', outcome: 'timeout' })).toBe(1);
    expect(exporter.getFinishedSpans().find((s) => s.name === 'operation.start')!.status.code).toBe(2);

    const dead = tracker.begin('start', 'ozc-2');
    dead.enqueued(comp({ id: 'ozc-2', stopped: true }));
    dead.progress(comp({ id: 'ozc-2', status: 'failed' }), false);
    expect(dead.outcome).toBe('failed');
  });

  it('joins a repeated start, completes destroy when gone, and records provider errors', async () => {
    let c: Computer | null = comp();
    const { metrics, tracker } = setup(() => ({ c, ready: false }));
    const a = tracker.begin('start', 'ozc-1');
    expect(tracker.begin('start', 'ozc-1')).toBe(a);
    // A destroy supersedes it.
    const d = tracker.begin('destroy', 'ozc-1');
    expect(a.outcome).toBe('error');
    d.enqueued();
    await tracker.pollOnce();
    expect(d.done).toBe(false);
    c = null;
    await tracker.pollOnce();
    expect(d.outcome).toBe('ok');

    await expect(tracker.timed('list', async () => { throw new Error('api down'); })).rejects.toThrow('api down');
    expect(await counter(metrics, { operation: 'list', outcome: 'error' })).toBe(1);
    expect(await tracker.timed('get', async () => 42)).toBe(42);
    expect(await counter(metrics, { operation: 'get', outcome: 'ok' })).toBe(1);
  });

  it('does not reset a joined start when its repeated provider call returns', async () => {
    const { metrics, tracker, at } = setup(() => ({ c: comp(), ready: false }));
    const op = tracker.begin('start', 'ozc-1');
    at(1); op.enqueued(comp({ stopped: true }));
    at(5); op.progress(comp(), false);
    expect(op.phase).toBe('boot');
    at(6); tracker.begin('start', 'ozc-1').enqueued(comp()); // a second start_computer
    expect(op.phase).toBe('boot');
    expect((await hist(metrics, 'operationPhase', { operation: 'start', phase: 'provision' })).count).toBe(1);
  });

  it('shares a running watcher pass, so slow probes never overlap', async () => {
    let probes = 0, release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tracker = new OperationTracker({ provider: 'fake', probe: async () => { probes++; await gate; return { c: comp(), ready: false }; } });
    tracker.begin('start', 'ozc-1').enqueued(comp({ stopped: true }));
    const a = tracker.pollOnce(), b = tracker.pollOnce();
    expect(a).toBe(b);
    release(); await a;
    expect(probes).toBe(1);
  });

  it('records observed time-to-ready once, at the first ready:true', async () => {
    const { metrics, tracker, at } = setup(() => ({ c: comp(), ready: false }));
    tracker.begin('create').enqueued(comp());
    at(10); tracker.observe(comp(), false);
    at(30); tracker.observe(comp(), true);
    at(40); tracker.observe(comp(), true);
    expect(await hist(metrics, 'timeToReadyObserved', {})).toEqual({ sum: 30, count: 1 });
  });
});

describe('operations through tool calls', () => {
  let inst: FastifyInstance, app: FastifyInstance, base: string;
  let healthy = false;
  const metrics = new Metrics({ defaultMetrics: false });

  beforeAll(async () => {
    inst = Fastify();
    inst.get('/health', async (_r, reply) => reply.code(healthy ? 204 : 503).send());
    await inst.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(inst.server.address() as any).port}`;
    const all = new Map<string, Computer>();
    const provider: Provider = {
      scheme: 'memory',
      async list(o) { return [...all.values()].filter((c) => c.owner === o); },
      async listAll() { return [...all.values()]; },
      async get(id) { return all.get(id) ?? null; },
      async create({ owner }) { const c = comp({ id: generateId(), owner: owner.id, internalUrl: url, token: 't' }); all.set(c.id, c); return c; },
      async start(id) { return all.get(id)!; },
      async destroy(id) { all.delete(id); },
    };
    const { isReady } = await import('../src/mcp.ts');
    // No watcher: the clients' polls alone must drive the operation to completion.
    const operations = new OperationTracker({ provider: 'memory', metrics, probe: (id) => isReady(provider, id) });
    app = await buildServer({ provider, catalog: [], client: new InstanceClient(), version: 't', psk: 'p', readyTimeoutMs: 0, metrics, operations });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  });
  afterAll(async () => { await app.close(); await inst.close(); });

  const tool = async (name: string, args: object = {}) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer p', 'x-ozwell-user-id': 'alice', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const data = (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    return JSON.parse(JSON.parse(data).result.content[0].text);
  };

  it('create→ready over three tool calls is one operation, linked from each call', async () => {
    const created = await tool('create_computer');
    expect(created.ready).toBe(false);
    expect((await tool('get_computer', { instance_id: created.instance_id })).ready).toBe(false);
    healthy = true;
    expect((await tool('get_computer', { instance_id: created.instance_id })).ready).toBe(true);

    expect(await counter(metrics, { operation: 'create', outcome: 'ok' })).toBe(1);
    expect(await inFlight(metrics, 'create')).toBe(0);
    expect((await hist(metrics, 'timeToReadyObserved', { provider: 'memory' })).count).toBe(1);

    const spans = exporter.getFinishedSpans();
    const [opSpan] = spans.filter((s) => s.name === 'operation.create');
    const calls = spans.filter((s) => s.name.startsWith('mcp.tools/call '));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.spanContext().traceId).not.toBe(opSpan.spanContext().traceId);
      expect(call.links.map((l) => l.context.spanId)).toContain(opSpan.spanContext().spanId);
    }
    // get_computer's ownership lookup (a get operation) is linked too.
    const gets = spans.filter((s) => s.name === 'operation.get');
    const getCall = calls.find((s) => s.name === 'mcp.tools/call get_computer')!;
    expect(getCall.links.map((l) => l.context.spanId)).toEqual(expect.arrayContaining([gets[0].spanContext().spanId]));
  });
});
