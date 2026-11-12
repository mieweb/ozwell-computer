import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

  it('drains idle control-plane TCP connections before checkpointing', async () => {
    const { app } = await make();
    const idleAgent = new Agent({ keepAlive: true }), prepareAgent = new Agent({ keepAlive: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    function call(path: string, agent: Agent, body?: object) {
      return new Promise<{ socket: Socket; headers: IncomingHttpHeaders; status: number }>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest(base + path, {
          method: payload ? 'POST' : 'GET', agent,
          headers: { ...auth, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        }, (res) => {
          const socket = res.socket;
          res.on('error', reject);
          res.on('end', () => resolve({ socket, headers: res.headers, status: res.statusCode! }));
          res.resume();
        });
        req.on('error', reject);
        req.end(payload);
      });
    }
    try {
      const idleConnection = await call('/health', idleAgent);
      expect(idleConnection.socket.destroyed).toBe(false);
      const prepared = await call('/api/v1/lifecycle/prepare', prepareAgent, { idle_ms: 0 });
      expect(prepared.status).toBe(200);
      expect(prepared.headers.connection).toBe('close');
      await vi.waitFor(() => {
        expect(idleConnection.socket.destroyed).toBe(true);
        expect(prepared.socket.destroyed).toBe(true);
      });
      for (const path of ['/health', '/api/v1/metrics', '/api/v1/lifecycle']) {
        const poll = await call(path, idleAgent);
        expect(poll.headers.connection).toBe('close');
        await vi.waitFor(() => expect(poll.socket.destroyed).toBe(true));
      }
    } finally { idleAgent.destroy(); prepareAgent.destroy(); await app.close(); }
  });

  it.each(['handler', 'early-handler', 'pre-handler', 'early-pre-handler', 'callback-pre-handler', 'inherited-pre-handler', 'handler-error', 'pre-handler-error'])(
    'retains disconnected %s work until its actual execution settles', async (kind) => {
      const app = Fastify();
      registerAuth(app, { token: 'secret-token' });
      const lifecycle = new Lifecycle(idle);
      registerLifecycle(app, lifecycle, false);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const began = new Promise<void>((resolve) => { entered = resolve; });
      const work = async (reply: any) => {
        entered();
        if (kind.startsWith('early-')) reply.send({ early: true });
        await gate;
        if (kind.endsWith('-error')) throw new Error('work failed after disconnect');
      };
      if (kind === 'inherited-pre-handler') app.addHook('preHandler', async (_req, reply) => { await work(reply); });
      app.post('/work', {
        ...(kind.includes('pre-handler') && kind !== 'inherited-pre-handler' ? {
          preHandler: kind === 'callback-pre-handler'
            ? function (_req: any, _reply: any, done: any) { entered(); void gate.then(() => done()); }
            : async (_req: any, reply: any) => { await work(reply); },
        } : {}),
      }, async (_req, reply) => {
        if (!kind.includes('pre-handler')) await work(reply);
        return { ok: true };
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const connected = once(app.server, 'connection');
      const req = httpRequest(`http://127.0.0.1:${(app.server.address() as any).port}/work`, { method: 'POST', headers: auth }, (res) => res.resume());
      req.on('error', () => {});
      req.end();
      const [socket] = await connected;
      try {
        await began;
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        req.destroy();
        await closed;
        expect(await lifecycle.status()).toMatchObject({ active_requests: 1, connections: 0 });
        await expect(lifecycle.prepare(0)).rejects.toMatchObject({ reason: 'not_idle' });
        release();
        await vi.waitFor(async () => expect((await lifecycle.status()).active_requests).toBe(0));
        await expect(lifecycle.prepare(0)).resolves.toMatchObject({ prepared: true });
      } finally { release(); req.destroy(); await app.close(); }
    },
  );

  it('releases admission after validation and prehandler errors without entering the handler', async () => {
    const app = Fastify();
    const lifecycle = new Lifecycle(idle);
    registerLifecycle(app, lifecycle, true);
    app.post('/validation', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, async () => ({ ok: true }));
    app.get('/rejected', { preHandler: async () => { throw new Error('rejected'); } }, async () => ({ ok: true }));
    try {
      expect((await app.inject({ method: 'POST', url: '/validation', payload: {} })).statusCode).toBe(400);
      expect((await app.inject('/rejected')).statusCode).toBe(500);
      expect((await lifecycle.status()).active_requests).toBe(0);
    } finally { await app.close(); }
  });

  it.each(['synchronous', 'delayed'])('supports a %s callback-hook early reply without done', async (kind) => {
    const app = Fastify();
    const lifecycle = new Lifecycle(idle);
    registerLifecycle(app, lifecycle, true);
    const handler = vi.fn(async () => ({ shouldNotRun: true }));
    app.get('/early', { preHandler: function (_req, reply, _done) {
      if (kind === 'delayed') setImmediate(() => { reply.code(403).send({ denied: true }); });
      else reply.code(403).send({ denied: true });
    } }, handler);
    try {
      expect((await app.inject('/early')).statusCode).toBe(403);
      expect(handler).not.toHaveBeenCalled();
      expect((await lifecycle.status()).active_requests).toBe(0);
    } finally { await app.close(); }
  });

  it('releases an incomplete request body after disconnect without invoking the handler', async () => {
    const app = Fastify();
    const lifecycle = new Lifecycle(idle);
    registerLifecycle(app, lifecycle, true);
    let admitted!: () => void;
    const began = new Promise<void>((resolve) => { admitted = resolve; });
    app.addHook('onRequest', async () => { admitted(); });
    const handler = vi.fn(async () => ({ ok: true }));
    app.post('/body', handler);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const connected = once(app.server, 'connection');
    const req = httpRequest(`http://127.0.0.1:${(app.server.address() as any).port}/body`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000' } });
    req.on('error', () => {}); req.write('{"incomplete":');
    const [socket] = await connected;
    try {
      await began;
      expect((await lifecycle.status()).active_requests).toBe(1);
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve())); req.destroy(); await closed;
      await vi.waitFor(async () => expect((await lifecycle.status()).active_requests).toBe(0));
      expect(handler).not.toHaveBeenCalled();
    } finally { req.destroy(); await app.close(); }
  });

  it('keeps a disconnected synchronous exec command active until the child process finishes', async () => {
    const { app, root } = await make();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const started = join(root, 'started'), proceed = join(root, 'proceed'), finished = join(root, 'finished');
    const script = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(started)},'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(finished)},'done')}},10)`;
    const body = JSON.stringify({ cmd: process.execPath, args: ['-e', script], timeout_ms: 10_000 });
    const connected = once(app.server, 'connection');
    const req = httpRequest(`http://127.0.0.1:${(app.server.address() as any).port}/api/v1/exec`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.on('error', () => {}); req.end(body);
    const [socket] = await connected;
    const status = async () => (await app.inject({ url: '/api/v1/lifecycle', headers: auth })).json();
    try {
      await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ready'));
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve())); req.destroy(); await closed;
      expect(await status()).toMatchObject({ active_requests: 1, running_jobs: 0 });
      expect((await app.inject({ method: 'POST', url: '/api/v1/lifecycle/prepare', headers: auth, payload: { idle_ms: 0 } })).statusCode).toBe(409);
      await writeFile(proceed, 'go');
      await vi.waitFor(async () => expect(await readFile(finished, 'utf8')).toBe('done'));
      await vi.waitFor(async () => expect((await status()).active_requests).toBe(0));
    } finally { await writeFile(proceed, 'go'); req.destroy(); await app.close(); }
  });

  it('keeps a disconnected MCP tool active after its HTTP adapter has returned', async () => {
    const { app, desktop } = await make();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { entered = resolve; });
    let adapterReturned = false;
    const handleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    const adapter = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementation(async function (this: StreamableHTTPServerTransport, ...args) {
      try { return await handleRequest.apply(this, args); }
      finally { if ((args[2] as { method?: string } | undefined)?.method === 'tools/call') adapterReturned = true; }
    });
    vi.spyOn(desktop, 'screenshot').mockImplementation(async () => { entered(); await gate; throw new Error('finished tool'); });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const headers: Record<string, string> = { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const initial = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1' } } }) });
    await initial.text();
    headers['mcp-session-id'] = initial.headers.get('mcp-session-id')!;
    headers['mcp-protocol-version'] = '2025-06-18';
    const initialized = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    await initialized.text();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
    const connected = once(app.server, 'connection');
    const req = httpRequest(base + '/mcp', { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, agent: false }, (res) => res.resume());
    req.on('error', () => {}); req.end(body);
    const [socket] = await connected;
    const status = async () => (await app.inject({ url: '/api/v1/lifecycle', headers: auth })).json();
    try {
      await began;
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve())); req.destroy(); await closed;
      await vi.waitFor(() => expect(adapterReturned).toBe(true));
      expect(await status()).toMatchObject({ active_requests: 1, running_jobs: 0 });
      expect((await app.inject({ method: 'POST', url: '/api/v1/lifecycle/prepare', headers: auth, payload: { idle_ms: 0 } })).statusCode).toBe(409);
      release();
      await vi.waitFor(async () => expect((await status()).active_requests).toBe(0));
    } finally { release(); req.destroy(); await app.close(); adapter.mockRestore(); }
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
