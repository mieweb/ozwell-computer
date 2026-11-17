// Instance traces: the OTLP JSON → protobuf re-encoding and the puller's traces stream,
// against a fake instance serving GET /api/v1/traces and a fake VictoriaTraces.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import protobuf from 'protobufjs';
import { LogPuller } from '../src/log-puller.ts';
import { otlpJsonToProto } from '../src/otlp.ts';
import { Metrics } from '../src/metrics.ts';
import type { Computer, Provider } from '../src/providers/types.ts';

// Just the opentelemetry-proto fields the encoder writes.
const root = protobuf.parse(`
syntax = "proto3";
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; string name = 5;
  int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10; repeated Event events = 11; Status status = 15; fixed32 flags = 16;
}
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message Status { string message = 2; int32 code = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; } }
message ArrayValue { repeated AnyValue values = 1; }
`).root;
const Req = root.lookupType('ExportTraceServiceRequest');
const decode = (b: Buffer | Uint8Array) => Req.toObject(Req.decode(b), { longs: String, bytes: String, defaults: false }) as any;

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const span = (i: number, extra: object = {}) => ({
  traceId: TRACE, spanId: (i + 1).toString(16).padStart(16, '0'), parentSpanId: 'b7ad6b7169203331', name: `s${i}`, kind: 1,
  startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000500000000',
  attributes: [{ key: 'n', value: { intValue: String(i) } }, { key: 'zero', value: { intValue: '0' } }], status: {}, ...extra,
});
const otlp = (spans: object[]) => ({
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ozwell-computer' } }, { key: 'ozwell.instance_id', value: { stringValue: 'spoofed' } }] },
    scopeSpans: [{ scope: { name: 'ozwell-computer' }, spans }],
  }],
});
const hex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');
const attrs = (kvs: any[]) => Object.fromEntries(kvs.map((kv) => [kv.key, kv.value.stringValue ?? kv.value.intValue ?? kv.value.boolValue ?? kv.value.doubleValue ?? 0]));

describe('otlpJsonToProto', () => {
  it('encodes spans and replaces the resource\'s ozwell attributes', () => {
    const { body, spans } = otlpJsonToProto(otlp([
      span(1, { status: { code: 2, message: 'boom' }, events: [{ timeUnixNano: '1700000000100000000', name: 'e' }] }),
      span(2, { attributes: [{ key: 'b', value: { boolValue: true } }, { key: 'd', value: { doubleValue: 1.5 } }, { key: 'neg', value: { intValue: '-3' } }] }),
      { ...span(3), traceId: 'nope' }, // invalid ids: dropped
    ]), { 'ozwell.instance_id': 'ozc-1', 'ozwell.user': 'alice' });
    expect(spans).toBe(2);
    const d = decode(body);
    const rs = d.resourceSpans[0];
    expect(attrs(rs.resource.attributes)).toEqual({ 'service.name': 'ozwell-computer', 'ozwell.instance_id': 'ozc-1', 'ozwell.user': 'alice' });
    const [a, b] = rs.scopeSpans[0].spans;
    expect(rs.scopeSpans[0].scope.name).toBe('ozwell-computer');
    expect(hex(a.traceId)).toBe(TRACE);
    expect(hex(a.parentSpanId)).toBe('b7ad6b7169203331');
    expect(a).toMatchObject({ name: 's1', kind: 1, startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000500000000', status: { code: 2, message: 'boom' } });
    expect(a.events[0]).toMatchObject({ name: 'e', timeUnixNano: '1700000000100000000' });
    expect(attrs(a.attributes)).toEqual({ n: '1', zero: '0' });
    expect(attrs(b.attributes)).toEqual({ b: true, d: 1.5, neg: '-3' });
  });

  it('refuses a request with more elements than the budget', () => {
    const many = span(1, { events: Array.from({ length: 50 }, () => ({ name: 'e' })) });
    expect(() => otlpJsonToProto(otlp([many]), {}, 40)).toThrow(/more than/);
    expect(otlpJsonToProto(otlp([many]), {}).spans).toBe(1);
  });

  it('keeps explicitly empty string and bytes values', () => {
    const { body } = otlpJsonToProto(otlp([span(1, { attributes: [{ key: 's', value: { stringValue: '' } }, { key: 'b', value: { bytesValue: '' } }, { key: 'u', value: {} }] })]), {});
    const [a] = decode(body).resourceSpans[0].scopeSpans[0].spans;
    const value = (k: string) => a.attributes.find((kv: any) => kv.key === k).value;
    expect(value('s')).toEqual({ stringValue: '' });
    expect(value('u')).toEqual({});
  });

  it('ignores garbage', () => {
    expect(otlpJsonToProto(null, {}).spans).toBe(0);
    expect(otlpJsonToProto({ resourceSpans: [1, 'x', { scopeSpans: 'y' }] }, {})).toMatchObject({ spans: 0 });
  });
});

describe('LogPuller traces', () => {
  let inst: FastifyInstance, vt: FastifyInstance, instUrl: string, vtUrl: string;
  let buffer: object[] = [];
  let requests: Array<{ cursor?: string; limit?: string }> = [];
  let shipped: any[] = [];
  let instStatus = 200, shipStatus = 200, dropped = 0, body: string | undefined;

  beforeAll(async () => {
    inst = Fastify();
    // A fake computer: the cursor is the index of the next span; "end" is the buffer's end.
    inst.get('/api/v1/traces', async (req, reply) => {
      const q = req.query as { cursor?: string; limit?: string };
      requests.push(q);
      if (req.headers.authorization !== 'Bearer t') return reply.code(401).send();
      if (instStatus !== 200) return reply.code(instStatus).send();
      const from = q.cursor === 'end' ? buffer.length : Number(q.cursor ?? 0);
      const out = buffer.slice(from, from + Number(q.limit));
      const next = from + out.length;
      return reply.header('ozwell-trace-cursor', String(next)).header('ozwell-trace-more', next < buffer.length ? '1' : '0')
        .header('ozwell-trace-dropped', String(dropped)).type('application/json').send(body ?? JSON.stringify(out.length ? otlp(out) : { resourceSpans: [] }));
    });
    await inst.listen({ port: 0, host: '127.0.0.1' });
    instUrl = `http://127.0.0.1:${(inst.server.address() as any).port}`;

    vt = Fastify();
    vt.addContentTypeParser('application/x-protobuf', { parseAs: 'buffer' }, (_r, b, done) => done(null, b));
    vt.post('/insert/opentelemetry/v1/traces', async (req, reply) => {
      if (shipStatus !== 200) return reply.code(shipStatus).send();
      shipped.push(decode(req.body as Buffer));
      return reply.send({});
    });
    await vt.listen({ port: 0, host: '127.0.0.1' });
    vtUrl = `http://127.0.0.1:${(vt.server.address() as any).port}/insert/opentelemetry/v1/traces`;
  });
  afterAll(async () => { await inst.close(); await vt.close(); });
  beforeEach(() => { buffer = []; requests = []; shipped = []; instStatus = 200; shipStatus = 200; dropped = 0; body = undefined; });

  function setup(computers: () => Computer[]) {
    let now = 1_000_000;
    const metrics = new Metrics({ defaultMetrics: false });
    const logs: Array<{ level: string; o: any; m: string }> = [];
    const provider: Provider = {
      scheme: 'memory', listAll: async () => computers(), list: async () => [], get: async () => null,
      create: async () => { throw new Error('no'); }, start: async () => { throw new Error('no'); }, destroy: async () => {},
    };
    const puller = new LogPuller({
      provider, traceShipUrl: vtUrl, metrics, pollMs: 5000, discoverMs: 0, recheckMs: 600_000, now: () => now,
      log: { info: (o, m) => logs.push({ level: 'info', o, m }), warn: (o, m) => logs.push({ level: 'warn', o, m }) },
    });
    return { puller, metrics, logs, advance: (s: number) => { now += s * 1000; } };
  }
  const comp = (over: Partial<Computer> = {}): Computer => ({ id: 'ozc-1', owner: 'u-1', ownerEmail: 'alice@example.com', status: 'running', stopped: false, internalUrl: instUrl, token: 't', ...over });
  const count = async (m: Metrics, outcome: string) => (await m.tracePulls.get()).values.find((v) => v.labels.outcome === outcome)?.value ?? 0;

  it('starts at the end of the buffer, then ships new spans tagged with the instance', async () => {
    buffer = [span(0)];
    const { puller, metrics, advance } = setup(() => [comp()]);
    await puller.tick();
    expect(requests[0]).toEqual({ cursor: 'end', limit: '1000' });
    expect(shipped).toHaveLength(0);
    buffer.push(span(1), span(2));
    dropped = 4;
    advance(5); await puller.tick();
    expect(requests[1].cursor).toBe('1');
    expect(shipped).toHaveLength(1);
    const rs = shipped[0].resourceSpans[0];
    expect(attrs(rs.resource.attributes)).toMatchObject({ 'ozwell.instance_id': 'ozc-1', 'ozwell.user': 'alice@example.com', 'ozwell.provider': 'memory' });
    expect(rs.scopeSpans[0].spans.map((s: any) => s.name)).toEqual(['s1', 's2']);
    expect((await metrics.traceSpansShipped.get()).values[0].value).toBe(2);
    expect((await metrics.traceSpansDropped.get()).values[0].value).toBe(4);
    advance(5); await puller.tick();
    expect(requests[2].cursor).toBe('3');
    expect(await count(metrics, 'ok')).toBe(3);
  });

  it('skips older instances (404) and re-checks later; logs and traces are independent streams', async () => {
    instStatus = 404;
    const { puller, metrics, logs, advance } = setup(() => [comp()]);
    await puller.tick();
    advance(60); await puller.tick();
    expect(requests).toHaveLength(1);
    expect((await metrics.tracePullUnsupported.get()).values[0].value).toBe(1);
    expect(logs.filter((l) => /no traces route/.test(l.m))).toHaveLength(1);
    instStatus = 200;
    advance(600); await puller.tick();
    expect(requests).toHaveLength(2);
    expect((await metrics.tracePullUnsupported.get()).values[0].value).toBe(0);
    expect([...(puller as any).states.keys()]).toEqual(['traces:ozc-1']);
  });

  it('keeps the cursor when VictoriaTraces refuses a batch, counting drops once', async () => {
    const { puller, metrics, advance } = setup(() => [comp()]);
    await puller.tick();
    buffer = [span(0)];
    dropped = 7;
    shipStatus = 500;
    advance(5); await puller.tick();
    expect(await count(metrics, 'ship_error')).toBe(1);
    expect((await metrics.traceSpansDropped.get()).values[0]?.value ?? 0).toBe(0);
    shipStatus = 200;
    advance(10); await puller.tick();
    expect(requests.map((r) => r.cursor)).toEqual(['end', '0', '0']);
    expect(shipped).toHaveLength(1);
    expect((await metrics.traceSpansDropped.get()).values[0].value).toBe(7);
  });

  it('halves the limit when a response exceeds the byte cap, and skips a span too large to read', async () => {
    const { puller, advance } = setup(() => [comp()]);
    await puller.tick();
    buffer = [span(0), span(1), span(2), span(3)];
    (puller as any).o.maxResponseBytes = JSON.stringify(otlp([span(0), span(1)])).length + 10;
    advance(5);
    await puller.tick(); // 4 spans: too large
    await puller.tick(); // retried at once with 500
    expect(requests.slice(1).map((r) => r.limit)).toEqual(['1000', '500']);
    (puller as any).o.maxResponseBytes = 10;
    for (let i = 0; i < 12; i++) await puller.tick();
    // Down to one span per pull, then each is skipped by its cursor.
    expect(requests.at(-1)!.limit).toBe('1');
    expect(shipped).toHaveLength(0);
    expect((puller as any).states.get('traces:ozc-1').cursor).not.toBe('0');
  });

  it('skips past an invalid response', async () => {
    const { puller, metrics, advance } = setup(() => [comp()]);
    await puller.tick();
    buffer = [span(0)];
    body = '{not json';
    advance(5); await puller.tick();
    expect(await count(metrics, 'error')).toBe(1);
    expect((puller as any).states.get('traces:ozc-1').cursor).toBe('1');
  });
});
