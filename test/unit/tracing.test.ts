import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers.js';
import { Tracer, tracer } from '../../src/tracing.js';
import { runCommand } from '../../src/process/exec.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const PARENT = 'b7ad6b7169203331';
const traceparent = `00-${TRACE}-${PARENT}-01`;

const spansOf = (body: any): any[] => body.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans));

describe('Tracer', () => {
  it('records nothing outside a traced request (background work)', async () => {
    const t = new Tracer();
    expect(await t.withSpan('poll', undefined, async (s) => { expect(s).toBeNull(); return 1; })).toBe(1);
    expect(t.size).toBe(0);
  });

  it('continues a traceparent and nests children under the active span', async () => {
    const t = new Tracer();
    await t.withSpan('outer', { a: 1 }, () => t.withSpan('inner', undefined, async () => undefined), { traceparent });
    const spans = spansOf(t.collect(undefined).body);
    expect(spans.map((s) => s.name)).toEqual(['inner', 'outer']);
    const [inner, outer] = spans;
    expect(outer).toMatchObject({ traceId: TRACE, parentSpanId: PARENT, kind: 1, attributes: [{ key: 'a', value: { intValue: '1' } }] });
    expect(inner).toMatchObject({ traceId: TRACE, parentSpanId: outer.spanId });
    expect(BigInt(outer.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(outer.startTimeUnixNano));
    expect((t.collect(undefined).body.resourceSpans[0] as any).resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'ozwell-computer' } });
  });

  it('prefers the active span over a traceparent in the same trace, and errors set the status', async () => {
    const t = new Tracer();
    const root = t.start('req', { traceparent })!;
    await expect(t.runWith(root, () => t.withSpan('tool', undefined, async () => { throw Object.assign(new Error('boom'), { reason: 'stale_snapshot' }); }, { traceparent: `00-${TRACE}-${'1'.repeat(16)}-01` }))).rejects.toThrow('boom');
    root.end();
    const [tool] = spansOf(t.collect(undefined).body);
    expect(tool).toMatchObject({ parentSpanId: root.ctx.spanId, status: { code: 2, message: 'boom' } });
    expect(tool.attributes).toContainEqual({ key: 'error.type', value: { stringValue: 'stale_snapshot' } });
  });

  it('caps attributes and value lengths', () => {
    const t = new Tracer();
    const s = t.start('x', { root: true })!;
    s.set(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(5000)]))).end();
    const [span] = spansOf(t.collect(undefined).body);
    expect(span.attributes).toHaveLength(32);
    expect(span.attributes[0].value.stringValue).toHaveLength(1024);
  });

  it('pages with a cursor, drops the oldest when full and reports what was dropped', () => {
    const t = new Tracer({ maxSpans: 5 });
    const add = (n: number) => { for (let i = 0; i < n; i++) t.start(`s${i}`, { root: true })!.end(); };
    add(3);
    const a = t.collect(undefined, 2);
    expect(a).toMatchObject({ spans: 2, more: true, dropped: 0 });
    const b = t.collect(a.cursor, 2);
    expect(b).toMatchObject({ spans: 1, more: false, dropped: 0 });
    expect(t.collect(b.cursor)).toMatchObject({ spans: 0, cursor: b.cursor });
    add(8); // 11 recorded, 6..11 kept... buffer holds the last 5
    expect(t.size).toBe(5);
    const c = t.collect(b.cursor);
    expect(c).toMatchObject({ spans: 5, dropped: 3 });
    // A cursor from another boot (a restarted computer) starts at the buffer's head.
    expect(t.collect(`ffffffff:${3}`)).toMatchObject({ spans: 5, dropped: 0 });
    expect(t.collect(`${t.boot}:999`)).toMatchObject({ spans: 5 });
  });

  it('caps a response in bytes, but always returns at least one span', () => {
    const t = new Tracer();
    for (let i = 0; i < 3; i++) t.start('x', { root: true, attrs: { big: 'v'.repeat(1000) } })!.end();
    expect(t.collect(undefined, 100, 10)).toMatchObject({ spans: 1, more: true });
  });
});

describe('GET /api/v1/traces', () => {
  let app: FastifyInstance;
  const auth = { authorization: 'Bearer secret-token' };
  const drain = async () => {
    let cursor: string | undefined;
    for (;;) {
      const r = await app.inject({ url: `/api/v1/traces${cursor ? `?cursor=${cursor}` : ''}`, headers: auth });
      cursor = r.headers['ozwell-trace-cursor'] as string;
      if (r.headers['ozwell-trace-more'] !== '1') return { cursor, r };
    }
  };
  beforeAll(async () => { ({ app } = await makeApp()); });
  afterAll(async () => { await app.close(); });
  let cursor: string;
  beforeEach(async () => { ({ cursor } = await drain()); });
  const since = async () => {
    const r = await app.inject({ url: `/api/v1/traces?cursor=${cursor}`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    return spansOf(r.json());
  };

  it('requires the token', async () => {
    expect((await app.inject({ url: '/api/v1/traces' })).statusCode).toBe(401);
  });

  it('serves a request span continuing the caller\'s traceparent, with work spans nested under it', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/exec', headers: { ...auth, traceparent }, payload: { cmd: 'true' } });
    const spans = await since();
    const req = spans.find((s) => s.name === 'POST /api/v1/exec');
    const exec = spans.find((s) => s.name === 'exec');
    expect(req).toMatchObject({ traceId: TRACE, parentSpanId: PARENT, kind: 2 });
    expect(req.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: '200' } });
    expect(exec).toMatchObject({ traceId: TRACE, parentSpanId: req.spanId });
    expect(exec.attributes).toContainEqual({ key: 'process.exit.code', value: { intValue: '0' } });
  });

  it('starts a trace for requests without a traceparent, but never traces polled routes', async () => {
    await app.inject({ url: '/api/v1/capabilities', headers: auth });
    await app.inject({ url: '/api/v1/metrics', headers: auth });
    await app.inject({ url: '/health' });
    const names = (await since()).map((s) => s.name);
    expect(names).toEqual(['GET /api/v1/capabilities']);
  });

  it('rejects a bad limit', async () => {
    expect((await app.inject({ url: '/api/v1/traces?limit=0', headers: auth })).statusCode).toBe(400);
  });
});

describe('work outside requests', () => {
  it('is not traced', async () => {
    const before = tracer.collect(undefined).cursor;
    await runCommand({ cmd: 'true' }, ':0');
    expect(tracer.collect(before).spans).toBe(0);
  });
});
