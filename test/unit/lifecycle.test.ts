import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lifecycle, MAX_LEASE_MS, registerLifecycle } from '../../src/lifecycle.js';
import { registerAuth } from '../../src/auth/plugin.js';
import { openSse } from '../../src/routes/sse.js';
import { makeApp } from '../helpers.js';

const idle = async () => ({ running_jobs: 0, busy: false });
const auth = { authorization: 'Bearer secret-token' };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('guest hibernation admission', () => {
  it('requires a full idle grace after the last request finishes and counts persistent connections', async () => {
    let now = 1000;
    const lifecycle = new Lifecycle(idle, () => now);
    now += 100;
    const finish = lifecycle.enter(true);
    expect(await lifecycle.status()).toMatchObject({ active_requests: 1, connections: 1, last_activity_at: 1100 });
    now += 10_000;
    await expect(lifecycle.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
    finish(); finish(); // raw finish/close must not decrement twice
    expect(await lifecycle.status()).toMatchObject({ active_requests: 0, connections: 0, last_activity_at: 11100 });
    now += 499;
    await expect(lifecycle.prepare(500)).rejects.toMatchObject({ reason: 'not_idle' });
    now++;
    const saved = await lifecycle.prepare(500);
    expect(saved).toMatchObject({ prepared: true, lease_id: expect.any(String), active_requests: 0 });
    expect(() => lifecycle.enter()).toThrow(/preparing to hibernate/);
    await expect(lifecycle.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
    now += 24 * 3600_000;
    expect((await lifecycle.status()).lease_id).toBe(saved.lease_id); // never silently thaws
    lifecycle.resume();
    lifecycle.enter()();
    expect(await lifecycle.status()).toMatchObject({ prepared: false, lease_id: null });
  });

  it('closes admission before an asynchronous workload check and rolls back on failure', async () => {
    let resolve!: (work: { running_jobs: number; busy: boolean }) => void;
    const lifecycle = new Lifecycle(() => new Promise((r) => { resolve = r; }));
    const preparing = lifecycle.prepare(0);
    expect(() => lifecycle.enter()).toThrow(/preparing to hibernate/);
    expect(() => lifecycle.keepAwake('late', 1000)).toThrow(/preparing to hibernate/);
    resolve({ running_jobs: 1, busy: false });
    await expect(preparing).rejects.toMatchObject({ reason: 'not_idle' });
    lifecycle.enter()();

    const broken = new Lifecycle(async () => { throw new Error('unreadable job state'); });
    await expect(broken.prepare(0)).rejects.toThrow('unreadable job state');
    broken.enter()(); // fail closed for the save, but retain normal service
  });

  it('refuses save for jobs and upgrades and detects concurrent recovery', async () => {
    const jobs = new Lifecycle(async () => ({ running_jobs: 1, busy: false }));
    await expect(jobs.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
    const update = new Lifecycle(async () => ({ running_jobs: 0, busy: true }));
    await expect(update.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
    let resolve!: (work: { running_jobs: number; busy: boolean }) => void;
    const race = new Lifecycle(() => new Promise((r) => { resolve = r; }));
    const preparing = race.prepare(0);
    race.resume();
    resolve({ running_jobs: 0, busy: false });
    await expect(preparing).rejects.toMatchObject({ reason: 'not_idle' });
    race.enter()();
  });

  it('supports bounded, renewable leases for arbitrary background applications', async () => {
    let now = 0;
    const lifecycle = new Lifecycle(idle, () => now);
    lifecycle.keepAwake('download', 1000);
    now = 500;
    lifecycle.keepAwake('download', 1000);
    now = 1000;
    await expect(lifecycle.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
    expect((await lifecycle.status()).leases).toBe(1);
    now = 1500;
    expect(await lifecycle.status()).toMatchObject({ leases: 0, last_activity_at: 1500 });
    await expect(lifecycle.prepare(1)).rejects.toMatchObject({ reason: 'not_idle' });
    lifecycle.keepAwake('build', 1000);
    lifecycle.release('build'); lifecycle.release('build');
    await expect(lifecycle.prepare(0)).resolves.toMatchObject({ prepared: true });
    lifecycle.resume();
    expect(() => lifecycle.keepAwake('bad/id', 100)).toThrow(/lease id/);
    for (const ttl of [0, -1, MAX_LEASE_MS + 1, Infinity, 1.2]) expect(() => lifecycle.keepAwake('bad', ttl)).toThrow(/ttl_ms/);
  });
});

describe('guest lifecycle HTTP API', () => {
  async function make() {
    const root = await mkdtemp(join(tmpdir(), 'oz-lifecycle-'));
    temporary.push(root);
    return { ...await makeApp({ tokenFile: join(root, 'token') }), root };
  }

  it('requires auth, preserves polling idleness, gates work, and explicitly resumes', async () => {
    const { app } = await make();
    try {
      expect((await app.inject('/api/v1/lifecycle')).statusCode).toBe(401);
      const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
      const before = (await request('GET', '/api/v1/lifecycle')).json();
      await new Promise((r) => setTimeout(r, 5));
      await app.inject('/health');
      await request('GET', '/api/v1/metrics');
      await app.inject('/api/v1/capabilities'); // denied attempts do not keep it awake
      const after = (await request('GET', '/api/v1/lifecycle')).json();
      expect(after.last_activity_at).toBe(before.last_activity_at);
      expect(after).toMatchObject({ active_requests: 0, connections: 0, running_jobs: 0, busy: false, leases: 0, prepared: false });
      expect((await request('PUT', '/api/v1/lifecycle/leases/download', { ttl_ms: 60_000 })).json().leases).toBe(1);
      expect((await request('POST', '/api/v1/lifecycle/prepare', { idle_ms: 0 })).statusCode).toBe(409);
      expect((await request('DELETE', '/api/v1/lifecycle/leases/download')).json().leases).toBe(0);
      expect((await request('PUT', '/api/v1/lifecycle/leases/download', { ttl_ms: MAX_LEASE_MS + 1 })).statusCode).toBe(400);
      const prepared = await request('POST', '/api/v1/lifecycle/prepare', { idle_ms: 0 });
      expect(prepared.statusCode).toBe(200);
      expect(prepared.json()).toMatchObject({ prepared: true, lease_id: expect.any(String) });
      const blocked = await request('GET', '/api/v1/capabilities');
      expect(blocked.statusCode).toBe(503);
      expect(blocked.headers['retry-after']).toBe('1');
      expect(blocked.json().error.reason).toBe('hibernating');
      expect((await request('POST', '/api/v1/lifecycle/resume', {})).json().prepared).toBe(false);
      expect((await request('GET', '/api/v1/capabilities')).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('discovers persisted running jobs from an earlier server before preparing', async () => {
    const { app, root } = await make();
    const dir = join(root, 'jobs', 'j-000000000000');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ command: 'persisted job', started: Date.now(), pid: process.pid }));
    try {
      expect((await app.inject({ url: '/api/v1/lifecycle', headers: auth })).json().running_jobs).toBe(1);
      const prepare = await app.inject({ method: 'POST', url: '/api/v1/lifecycle/prepare', headers: auth, payload: { idle_ms: 0 } });
      expect(prepare.statusCode).toBe(409);
      expect((await app.inject({ url: '/api/v1/capabilities', headers: auth })).statusCode).toBe(200);
      await writeFile(join(dir, 'exit'), '0');
      expect((await app.inject({ method: 'POST', url: '/api/v1/lifecycle/prepare', headers: auth, payload: { idle_ms: 0 } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('keeps hijacked SSE and upgraded WebSocket requests active until their actual connection closes', async () => {
    const app = Fastify();
    await app.register(websocket);
    registerAuth(app, { token: 'secret-token' });
    const lifecycle = new Lifecycle(idle);
    registerLifecycle(app, lifecycle, false);
    app.get('/api/v1/events', async (_req, reply) => { openSse(reply, '/api/v1/events').send('hello', {}); });
    app.get('/ws', { websocket: true }, (socket) => { socket.send('hello'); });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const abort = new AbortController();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: auth });
    try {
      await once(ws, 'message');
      const response = await fetch(base + '/api/v1/events', { headers: auth, signal: abort.signal });
      expect(response.status).toBe(200);
      expect(await lifecycle.status()).toMatchObject({ active_requests: 2, connections: 2 });
      await expect(lifecycle.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
      ws.close();
      await once(ws, 'close');
      abort.abort();
      await vi.waitFor(async () => expect(await lifecycle.status()).toMatchObject({ active_requests: 0, connections: 0 }));
      await expect(lifecycle.prepare(0)).resolves.toMatchObject({ prepared: true });
    } finally { abort.abort(); ws.terminate(); await app.close(); }
  });
});
