import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { instrumentProvider } from '../src/instrument-provider.ts';
import { buildSdk, telemetryConfig, telemetryEnabled } from '../src/telemetry.ts';
import type { Computer, Provider } from '../src/providers/types.ts';

const exporter = new InMemorySpanExporter();
const tp = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
beforeAll(() => { trace.setGlobalTracerProvider(tp); });
afterAll(async () => { await tp.shutdown(); trace.disable(); });
beforeEach(() => exporter.reset());

const comp: Computer = { id: 'ozc-1', owner: 'alice', status: 'running', stopped: false } as Computer;
const fake: Provider = {
  scheme: 'fake',
  list: async () => [comp],
  listAll: async () => [comp],
  get: async (id) => (id === comp.id ? comp : null),
  create: async () => comp,
  start: async () => comp,
  destroy: async () => { throw new Error('boom'); },
};

describe('instrumentProvider', () => {
  it('wraps every method in a provider.<method> span and reports timings', async () => {
    const calls: any[] = [];
    const p = instrumentProvider(fake, (c) => calls.push(c));
    expect(p.scheme).toBe('fake');
    expect(await p.list('alice')).toEqual([comp]);
    expect(await p.get('nope')).toBeNull();
    await p.create({ owner: { id: 'alice' } });
    await p.start('ozc-1');
    await expect(p.destroy('ozc-1')).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(['provider.list', 'provider.get', 'provider.create', 'provider.start', 'provider.destroy']);
    expect(spans[0].attributes).toMatchObject({ 'ozwell.provider': 'fake', 'enduser.id': 'alice', 'ozwell.count': 1 });
    expect(spans[1].attributes).toMatchObject({ 'ozwell.instance_id': 'nope', 'ozwell.found': false });
    expect(spans[2].attributes).toMatchObject({ 'enduser.id': 'alice', 'ozwell.instance_id': 'ozc-1', 'ozwell.status': 'running' });
    expect(spans[4].status.code).toBe(2); // ERROR
    expect(spans[4].attributes['error.type']).toBe('Error');

    expect(calls.map((c) => `${c.method}:${c.outcome}`)).toEqual(['list:ok', 'get:ok', 'create:ok', 'start:ok', 'destroy:error']);
    expect(calls.every((c) => c.provider === 'fake' && c.seconds >= 0)).toBe(true);
  });
});

describe('telemetry config', () => {
  it('is a no-op without OTLP endpoints', () => {
    const c = telemetryConfig({});
    expect(telemetryEnabled(c)).toBe(false);
    expect(buildSdk(c)).toBeNull();
    expect(c.serviceName).toBe('ozwell-computer-orchestrator');
  });
  it('builds an SDK when either endpoint is set', () => {
    const c = telemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces', OTEL_SERVICE_NAME: 'x' });
    expect(telemetryEnabled(c)).toBe(true);
    expect(c.serviceName).toBe('x');
    expect(buildSdk(c)).not.toBeNull();
  });
});
