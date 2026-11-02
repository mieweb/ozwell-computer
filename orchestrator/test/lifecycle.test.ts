import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IdleController } from '../src/lifecycle.ts';
import { buildServer } from '../src/server.ts';
import { InstanceClient } from '../src/instance-client.ts';
import type { Computer, Provider } from '../src/providers/types.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const app = Fastify();
  let prepared = false;
  let healthy = true;
  let busy = false;
  let lastActivity = Date.now() - 10_000;
  const leases = new Map<string, number>();
  const calls: string[] = [];
  let failSave: 'before' | 'after' | undefined;
  let daemonJob = false;
  let interruptedSave = false;
  let failResume = false;
  let restoreMissing = false;
  let prepareWait: Promise<void> | undefined;
  let saveWait: Promise<void> | undefined;
  const state = () => ({ last_activity_at: lastActivity, active_requests: 0, connections: 0, running_jobs: busy ? 1 : 0, busy, leases: leases.size, prepared, lease_id: prepared ? 'saved-reservation' : null });
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    expect(req.headers.authorization).toBe('Bearer guest-secret');
    calls.push(`${req.method} ${req.url}`);
    if (prepared && !req.url.startsWith('/api/v1/lifecycle')) return reply.code(503).send();
  });
  app.get('/health', async (_req, reply) => reply.code(healthy ? 204 : 503).send());
  app.get('/api/v1/lifecycle', async () => state());
  app.post('/api/v1/lifecycle/prepare', async (req, reply) => {
    const idle = (req.body as { idle_ms: number }).idle_ms;
    if (busy || leases.size || prepared || Date.now() - lastActivity < idle) return reply.code(409).send();
    prepared = true;
    await prepareWait;
    return state();
  });
  app.post('/api/v1/lifecycle/resume', async (_req, reply) => {
    if (failResume) return reply.code(500).send();
    prepared = false; lastActivity = Date.now(); return state();
  });
  app.put('/api/v1/lifecycle/leases/:id', async (req, reply) => {
    if (prepared) return reply.code(503).send();
    leases.set((req.params as { id: string }).id, Date.now() + (req.body as { ttl_ms: number }).ttl_ms);
    return state();
  });
  app.delete('/api/v1/lifecycle/leases/:id', async (req) => { leases.delete((req.params as { id: string }).id); return state(); });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  let computer: Computer = { id: 'ozc-test', owner: 'alice', status: 'running', stopped: false, hibernated: false, internalUrl: `http://127.0.0.1:${(app.server.address() as any).port}`, token: 'guest-secret' };
  let queue: Promise<unknown> = Promise.resolve();
  const lockContext = new AsyncLocalStorage<boolean>();
  const provider: Provider = {
    scheme: 'memory', list: async () => [{ ...computer }], listAll: async () => [{ ...computer }], get: async () => ({ ...computer }),
    create: async () => ({ ...computer }), destroy: async () => {},
    withLock: async (_id, fn) => {
      if (daemonJob) throw new Error('daemon save job is still active');
      if (lockContext.getStore()) return fn();
      const run = () => lockContext.run(true, fn);
      const next = queue.then(run, run); queue = next.catch(() => {}); return next;
    },
    start: vi.fn(async () => {
      calls.push('start');
      if (restoreMissing) throw new Error('saved state missing; refusing cold boot');
      computer = { ...computer, status: 'running', stopped: false, hibernated: false }; return { ...computer };
    }),
    hibernate: vi.fn(async () => {
      calls.push('save'); await saveWait;
      expect(prepared).toBe(true);
      if (failSave === 'before') { if (interruptedSave) daemonJob = true; throw new Error('save failed'); }
      computer = { ...computer, status: 'hibernated', stopped: true, hibernated: true };
      if (failSave === 'after') throw new Error('save response lost');
      return { ...computer };
    }),
  };
  const controller = new IdleController(provider, { idleMs: 1000, readyTimeoutMs: 200, requestTimeoutMs: 1000 });
  cleanups.push(() => controller.close());
  return {
    provider, controller, calls, leases, state, computer: () => computer,
    busy: (v: boolean) => { busy = v; }, old: () => { lastActivity = Date.now() - 10_000; },
    prepared: (v: boolean) => { prepared = v; }, failedSave: (v: typeof failSave) => { failSave = v; },
    healthy: (v: boolean) => { healthy = v; },
    failedResume: (v: boolean) => { failResume = v; }, missing: () => { restoreMissing = true; },
    prepareWait: (p: Promise<void>) => { prepareWait = p; }, saveWait: (p: Promise<void>) => { saveWait = p; },
    stopped: () => { computer = { ...computer, stopped: true, status: 'shut-off', hibernated: false }; },
    pendingSave: () => { computer = { ...computer, hibernated: true }; },
    interruptedSave: () => { interruptedSave = true; failSave = 'before'; },
    settleDaemonJob: () => { daemonJob = false; },
  };
}

describe('idle managed-save controller', () => {
  it('prepares an idle guest, saves once, and shares one restore across concurrent requests', async () => {
    const f = await fixture();
    await f.controller.sweep();
    expect(f.computer()).toMatchObject({ stopped: true, hibernated: true });
    expect(f.calls.indexOf('POST /api/v1/lifecycle/prepare')).toBeLessThan(f.calls.indexOf('save'));
    const [a, b] = await Promise.all([f.controller.acquire('ozc-test'), f.controller.acquire('ozc-test')]);
    expect(f.provider.start).toHaveBeenCalledTimes(1);
    expect(f.state().prepared).toBe(false);
    expect(f.leases.size).toBe(2);
    await f.controller.sweep();
    expect(f.provider.hibernate).toHaveBeenCalledTimes(1);
    a.release(); a.release(); b.release();
    await vi.waitFor(() => expect(f.leases.size).toBe(0));
  });

  it('refuses jobs and manual leases, then saves after release and the idle grace', async () => {
    const f = await fixture();
    f.busy(true); await f.controller.sweep();
    expect(f.provider.hibernate).not.toHaveBeenCalled();
    f.busy(false); await f.controller.keepAwake('ozc-test', 10_000);
    await vi.waitFor(() => expect(f.leases.size).toBe(1));
    f.old(); await f.controller.sweep();
    expect(f.provider.hibernate).not.toHaveBeenCalled();
    await f.controller.allowIdle('ozc-test'); f.old(); await f.controller.sweep();
    expect(f.provider.hibernate).toHaveBeenCalledTimes(1);
    await expect(f.controller.keepAwake('ozc-test', 86_400_001)).rejects.toMatchObject({ reason: 'invalid_request' });
  });

  it('cancels prepare when a new request arrives during the idle decision', async () => {
    const f = await fixture();
    let finish!: () => void;
    f.prepareWait(new Promise<void>((r) => { finish = r; }));
    const saving = f.controller.sweep();
    await vi.waitFor(() => expect(f.state().prepared).toBe(true));
    const acquiring = f.controller.acquire('ozc-test');
    finish(); await saving;
    const lease = await acquiring;
    expect(f.provider.hibernate).not.toHaveBeenCalled();
    expect(f.provider.start).not.toHaveBeenCalled();
    expect(f.state().prepared).toBe(false);
    lease.release();
  });

  it('queues a request behind an already started save, then restores before admitting it', async () => {
    const f = await fixture();
    let finish!: () => void;
    f.saveWait(new Promise<void>((r) => { finish = r; }));
    const saving = f.controller.sweep();
    await vi.waitFor(() => expect(f.calls).toContain('save'));
    const acquiring = f.controller.acquire('ozc-test');
    finish(); await saving;
    const active = await acquiring;
    expect(f.provider.hibernate).toHaveBeenCalledTimes(1);
    expect(f.provider.start).toHaveBeenCalledTimes(1);
    expect(f.calls.indexOf('start')).toBeGreaterThan(f.calls.indexOf('save'));
    expect(active.computer.stopped).toBe(false); active.release();
  });

  it('reopens admission after save failure without cold booting a completed save', async () => {
    const f = await fixture(); f.failedSave('before');
    await expect(f.controller.hibernate('ozc-test')).rejects.toThrow('save failed');
    expect(f.state().prepared).toBe(false); expect(f.provider.start).not.toHaveBeenCalled();
    f.old(); f.failedSave('after');
    await expect(f.controller.hibernate('ozc-test')).rejects.toThrow('save response lost');
    expect(f.state().prepared).toBe(true); expect(f.provider.start).not.toHaveBeenCalled();
    f.missing();
    await expect(f.controller.acquire('ozc-test')).rejects.toThrow('refusing cold boot');
    expect(f.computer().hibernated).toBe(true);
  });

  it('recovers a prepared running guest at startup while leaving saved computers asleep', async () => {
    const f = await fixture(); f.prepared(true);
    await f.controller.start(); expect(f.state().prepared).toBe(false);
    f.old(); await f.controller.hibernate('ozc-test');
    const restarted = new IdleController(f.provider, { idleMs: 0 });
    cleanups.push(() => restarted.close());
    await restarted.start();
    expect(f.provider.start).not.toHaveBeenCalled();
    expect(f.computer().hibernated).toBe(true);
    const active = await restarted.acquire('ozc-test'); active.release();
    expect(f.provider.start).toHaveBeenCalledTimes(1);
  });

  it('keeps admission closed when a failed save leaves a daemon job running', async () => {
    const f = await fixture(); f.interruptedSave();
    await expect(f.controller.hibernate('ozc-test')).rejects.toThrow('save failed');
    expect(f.state().prepared).toBe(true);
    expect(f.calls).not.toContain('POST /api/v1/lifecycle/resume');
    await expect(f.controller.acquire('ozc-test')).rejects.toThrow('daemon save job is still active');
    expect(f.state().prepared).toBe(true);
    f.settleDaemonJob();
    const active = await f.controller.acquire('ozc-test');
    expect(f.state().prepared).toBe(false); active.release();
  });

  it('saves a running guest with durable intent left by a crash before managedsave started', async () => {
    const f = await fixture(); f.pendingSave();
    await f.controller.sweep();
    expect(f.provider.hibernate).toHaveBeenCalledTimes(1);
    expect(f.computer()).toMatchObject({ stopped: true, hibernated: true });
  });

  it('fails closed when the guest resume handshake fails and keeps ordinary shutdown explicit', async () => {
    const f = await fixture(); f.failedResume(true);
    await expect(f.controller.acquire('ozc-test')).rejects.toThrow('HTTP 500');
    expect(f.leases.size).toBe(0);
    f.failedResume(false); f.stopped();
    await expect(f.controller.acquire('ozc-test')).rejects.toMatchObject({ reason: 'computer_stopped' });
    expect(f.provider.start).not.toHaveBeenCalled();
    const active = await f.controller.acquire('ozc-test', true); active.release();
    expect(f.provider.start).toHaveBeenCalledTimes(1);
  });
});

describe('hibernation through orchestrator MCP', () => {
  async function setup() {
    const f = await fixture();
    const client = new InstanceClient();
    vi.spyOn(client, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'desktop result' }] });
    const app = await buildServer({ provider: f.provider, lifecycle: f.controller, client, psk: 'workspace-secret', version: 'test',
      catalog: [{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const url = `http://127.0.0.1:${(app.server.address() as any).port}/mcp`;
    const rpc = async (user: string, method: string, params: object) => {
      const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer workspace-secret', 'x-ozwell-user-id': user,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const body = await response.text();
      const message = JSON.parse(body.startsWith('{') ? body : body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join(''));
      expect(message.error).toBeUndefined();
      return message.result;
    };
    const tool = async (user: string, name: string, args: object = {}) => {
      const result = await rpc(user, 'tools/call', { name, arguments: { instance_id: 'ozc-test', ...args } });
      let data: any = result.content[0].text;
      try { data = JSON.parse(data); } catch { /* Proxied plain text. */ }
      return { error: !!result.isError, data };
    };
    return { ...f, rpc, tool, client };
  }

  it('enforces ownership before lifecycle operations and automatically wakes a desktop tool', async () => {
    const f = await setup();
    expect((await f.rpc('alice', 'tools/list', {})).tools.map((t: any) => t.name)).toContain('hibernate_computer');
    for (const name of ['hibernate_computer', 'keep_computer_awake', 'allow_computer_hibernation', 'screenshot']) {
      expect(await f.tool('bob', name)).toMatchObject({ error: true, data: { error: { reason: 'target_unavailable' } } });
    }
    expect(f.provider.hibernate).not.toHaveBeenCalled(); expect(f.provider.start).not.toHaveBeenCalled();
    expect(await f.tool('alice', 'keep_computer_awake', { ttl_ms: 5000 })).toMatchObject({ error: false, data: { ok: true } });
    expect(await f.tool('alice', 'hibernate_computer')).toMatchObject({ error: true, data: { error: { reason: 'not_idle' } } });
    await f.tool('alice', 'allow_computer_hibernation');
    await vi.waitFor(() => expect(f.leases.size).toBe(0));
    expect(await f.tool('alice', 'hibernate_computer')).toMatchObject({ error: false, data: { stopped: true, hibernated: true } });
    expect(await f.tool('alice', 'get_computer')).toMatchObject({ error: false, data: { ready: false, hibernated: true } });
    expect(f.provider.start).not.toHaveBeenCalled();
    expect(await f.tool('alice', 'screenshot')).toEqual({ error: false, data: 'desktop result' });
    expect(f.provider.start).toHaveBeenCalledTimes(1);
    expect(f.client.callTool).toHaveBeenCalledWith(expect.any(String), f.computer().internalUrl, 'guest-secret', 'agent', 'screenshot', {});
  });

  it('returns ready false after a cold-boot wait budget and retains the error envelope on handshake failure', async () => {
    const f = await setup(); f.healthy(false);
    expect(await f.tool('alice', 'create_computer')).toMatchObject({ error: false, data: { ready: false } });
    f.healthy(true); f.failedResume(true);
    expect(await f.tool('alice', 'start_computer')).toMatchObject({ error: true, data: { error: { reason: 'target_unavailable' } } });
  });
});
