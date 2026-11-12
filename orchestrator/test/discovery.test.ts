// Phase 3: /sd service discovery and the /instances/:id/metrics scrape proxy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildInternalServer, sdTargets } from '../src/internal-server.ts';
import { Metrics } from '../src/metrics.ts';
import type { Computer, Provider } from '../src/providers/types.ts';

let inst: FastifyInstance, instUrl: string, deadUrl: string;
let scrapes = 0;

beforeAll(async () => {
  inst = Fastify();
  inst.get('/api/v1/metrics', async (req, reply) => {
    scrapes++;
    if (req.headers.authorization !== 'Bearer good') return reply.code(401).send();
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send('ozwell_up 1\n');
  });
  await inst.listen({ port: 0, host: '127.0.0.1' });
  instUrl = `http://127.0.0.1:${(inst.server.address() as any).port}`;
  // A port nothing listens on.
  const tmp = Fastify();
  await tmp.listen({ port: 0, host: '127.0.0.1' });
  deadUrl = `http://127.0.0.1:${(tmp.server.address() as any).port}`;
  await tmp.close();
});
afterAll(async () => { await inst.close(); });

const comp = (id: string, over: Partial<Computer> = {}): Computer =>
  ({ id, owner: 'alice', status: 'running', stopped: false, internalUrl: instUrl, token: 'good', ...over });

function provider(computers: () => Computer[], calls = { listAll: 0 }): Provider & { calls: typeof calls } {
  return {
    scheme: 'memory', calls,
    async list(o) { return computers().filter((c) => c.owner === o); },
    async listAll() { calls.listAll++; return computers(); },
    async get(id) { return computers().find((c) => c.id === id) ?? null; },
    async create() { throw new Error('no'); },
    async start() { throw new Error('no'); },
    async destroy() {},
  };
}

describe('sdTargets', () => {
  it('lists running, reachable computers pointed at the scrape proxy', () => {
    const t = sdTargets([comp('a'), comp('b', { stopped: true }), comp('c', { token: undefined }), comp('d', { owner: 'u-9', ownerEmail: 'bob@example.com', displayName: 'Bob box', createdAt: '2026-11-12T10:00:00.000Z' })], 'memory', 'orchestrator:8091');
    expect(t).toEqual([
      { targets: ['orchestrator:8091'], labels: { instance_id: 'a', provider: 'memory', user: 'alice', __metrics_path__: '/instances/a/metrics' } },
      { targets: ['orchestrator:8091'], labels: { instance_id: 'd', provider: 'memory', user: 'bob@example.com', display_name: 'Bob box', created_at: '2026-11-12T10:00:00.000Z', __metrics_path__: '/instances/d/metrics' } },
    ]);
  });
});

describe('internal server', () => {
  it('serves /sd from a cached listing and reports provider failures', async () => {
    let fail = false;
    const p = provider(() => { if (fail) throw new Error('api down'); return [comp('a'), comp('b', { stopped: true })]; });
    const app = await buildInternalServer({ metrics: new Metrics({ defaultMetrics: false }), provider: p, sdAddress: 'orch:8091', sdCacheMs: 50 });
    try {
      const [r1, r2] = await Promise.all([app.inject('/sd'), app.inject('/sd')]);
      expect(r1.statusCode).toBe(200);
      expect(r1.json()).toEqual([{ targets: ['orch:8091'], labels: { instance_id: 'a', provider: 'memory', user: 'alice', __metrics_path__: '/instances/a/metrics' } }]);
      expect(r2.json()).toEqual(r1.json());
      expect(p.calls.listAll).toBe(1);
      fail = true;
      expect((await app.inject('/sd')).statusCode).toBe(200); // still cached
      await new Promise((r) => setTimeout(r, 60));
      expect((await app.inject('/sd')).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('proxies an instance scrape with its token, and 404s/503s otherwise', async () => {
    const all = [comp('a'), comp('stopped', { stopped: true, status: 'offline' }), comp('gone', { internalUrl: deadUrl }), comp('badtoken', { token: 'bad' })];
    const app = await buildInternalServer({ metrics: new Metrics({ defaultMetrics: false }), provider: provider(() => all) });
    try {
      const ok = await app.inject('/instances/a/metrics');
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('ozwell_up 1\n');
      expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0.0.4/);

      expect((await app.inject('/instances/nope/metrics')).statusCode).toBe(404);
      const before = scrapes;
      expect((await app.inject('/instances/stopped/metrics')).statusCode).toBe(503);
      expect(scrapes).toBe(before); // a stopped computer isn't contacted
      expect((await app.inject('/instances/gone/metrics')).statusCode).toBe(503);
      const bad = await app.inject('/instances/badtoken/metrics');
      expect(bad.statusCode).toBe(503);
      expect(bad.json().error.message).toMatch(/HTTP 401/);
    } finally {
      await app.close();
    }
  });

  it('answers 503 when the provider lookup fails', async () => {
    const app = await buildInternalServer({ metrics: new Metrics({ defaultMetrics: false }), provider: provider(() => { throw new Error('api down'); }) });
    try {
      const r = await app.inject('/instances/a/metrics');
      expect(r.statusCode).toBe(503);
      expect(r.json().error.reason).toBe('provider_error');
    } finally {
      await app.close();
    }
  });

  it('requires the token on every route but /health when one is set', async () => {
    const app = await buildInternalServer({ metrics: new Metrics({ defaultMetrics: false }), provider: provider(() => [comp('a')]), token: 'int' });
    try {
      for (const url of ['/metrics', '/sd', '/instances/a/metrics']) {
        expect((await app.inject(url)).statusCode, url).toBe(401);
        expect((await app.inject({ url, headers: { authorization: 'Bearer wrong' } })).statusCode, url).toBe(401);
        expect((await app.inject({ url, headers: { authorization: 'Bearer int' } })).statusCode, url).toBe(200);
      }
      expect((await app.inject('/health')).statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it('serves only /metrics without a provider', async () => {
    const app = await buildInternalServer({ metrics: new Metrics({ defaultMetrics: false }) });
    try {
      expect((await app.inject('/metrics')).statusCode).toBe(200);
      expect((await app.inject('/sd')).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
