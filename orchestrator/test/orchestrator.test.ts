import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { InstanceClient } from '../src/instance-client.ts';
import { proxiedTools, type ToolDef } from '../src/mcp.ts';
import { providerFromUri, registerProvider } from '../src/providers/index.ts';
import { generateId, type Computer, type Provider } from '../src/providers/types.ts';

const PSK = 'orchestrator-psk';
const catalog: ToolDef[] = [
  { name: 'screenshot', description: 'Capture', inputSchema: { type: 'object', properties: { max_dimension: { type: 'number' } } } },
  { name: 'slow', description: 'Slow', inputSchema: { type: 'object', properties: {} } },
  { name: 'click', description: 'Click', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
];

/** Fake ozwell-computer MCP endpoint: records calls, checks its token. */
async function fakeInstance(token: string) {
  const calls: Array<{ name: string; args: any; client: string }> = [];
  let client = '';
  const app = Fastify();
  app.post('/mcp', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send();
    const m = req.body as any;
    if (m.method === 'initialize') {
      client = m.params.clientInfo.name;
      return reply.header('mcp-session-id', 'sess-1').send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
    }
    if (m.method === 'notifications/initialized') return reply.code(202).send();
    if (m.method === 'tools/call') {
      if (m.params.name === 'slow') await new Promise((r) => setTimeout(r, 1500));
      calls.push({ name: m.params.name, args: m.params.arguments, client });
      return reply.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `did ${m.params.name}` }] } });
    }
    return reply.code(400).send();
  });
  app.delete('/mcp', async (_r, reply) => reply.code(200).send());
  app.get('/health', async (_r, reply) => reply.code(204).send());
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, calls, url: `http://127.0.0.1:${(app.server.address() as any).port}` };
}

/** In-memory provider; every computer points at the fake instance. */
function memoryProvider(url: string, token: string): Provider & { all: Map<string, Computer> } {
  const all = new Map<string, Computer>();
  return {
    scheme: 'memory',
    all,
    async list(owner) { return [...all.values()].filter((c) => c.owner === owner); },
    async get(id) { return all.get(id) ?? null; },
    async create({ owner, displayName }) {
      const c: Computer = { id: generateId(), owner: owner.id, ownerName: owner.name, displayName, status: 'running', stopped: false, internalUrl: url, externalUrl: 'https://view.example', token };
      all.set(c.id, c);
      return c;
    },
    async start(id) {
      const c = { ...all.get(id)!, status: 'running', stopped: false, internalUrl: url };
      all.set(id, c);
      return c;
    },
    async destroy(id) { all.delete(id); },
  };
}

/** A stand-in for the site proxy answering 503; `onHit` runs on each request. */
async function unavailable(onHit: () => void) {
  const app = Fastify();
  app.all('/*', async (_r, reply) => { onHit(); return reply.code(503).type('text/html').send('<h1>503</h1>'); });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${(app.server.address() as any).port}` };
}

/** Opens MCP sessions, then answers tools/call with a 503 carrying a JSON-RPC error body. */
async function rpcUnavailable(onHit: () => void) {
  const app = Fastify();
  app.post('/mcp', async (req, reply) => {
    const m = req.body as any;
    if (m.method === 'initialize') return reply.header('mcp-session-id', 's1').send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } });
    if (!m.id) return reply.code(202).send();
    onHit();
    return reply.code(503).send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Service Unavailable' } });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${(app.server.address() as any).port}` };
}

let instance: Awaited<ReturnType<typeof fakeInstance>>;
let provider: ReturnType<typeof memoryProvider>;
let app: FastifyInstance;
let base: string;

async function rpc(user: string | null, method: string, params: object = {}, auth = PSK) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(user ? { 'x-ozwell-user-id': user, 'x-ozwell-user-name': `Name of ${user}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const ct = r.headers.get('content-type') ?? '';
  const raw = await r.text();
  const sse = ct.includes('text/event-stream') ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : raw;
  let body: any = sse;
  try { body = JSON.parse(sse); } catch { /* text */ }
  return { status: r.status, body };
}
const tool = async (user: string, name: string, args: object = {}) => {
  const r = await rpc(user, 'tools/call', { name, arguments: args });
  const res = r.body.result;
  return { isError: !!res.isError, data: (() => { try { return JSON.parse(res.content[0].text); } catch { return res.content[0].text; } })() };
};

beforeAll(async () => {
  instance = await fakeInstance('inst-token');
  provider = memoryProvider(instance.url, 'inst-token');
  app = await buildServer({ provider, catalog, client: new InstanceClient(), version: 't', psk: PSK, readyTimeoutMs: 5000 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
});
afterAll(async () => { await app.close(); await instance.app.close(); });

describe('auth and headers', () => {
  it('requires the PSK and the Ozwell user id', async () => {
    expect((await rpc('alice', 'tools/list', {}, '')).status).toBe(401);
    expect((await rpc('alice', 'tools/list', {}, 'wrong')).status).toBe(401);
    expect((await rpc(null, 'tools/list')).status).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(204);
  });
});

describe('tools', () => {
  it('lists management tools and every computer tool with a required instance_id', async () => {
    const tools = (await rpc('alice', 'tools/list')).body.result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(['list_computers', 'create_computer', 'get_computer', 'start_computer', 'destroy_computer', 'screenshot', 'slow', 'click']);
    const click = tools.find((t: any) => t.name === 'click');
    expect(click.inputSchema.required).toEqual(['instance_id', 'x', 'y']);
    expect(click.inputSchema.properties).toHaveProperty('instance_id');
  });

  it('creates per-user computers that other users cannot see or use', async () => {
    const a = (await tool('alice', 'create_computer', { display_name: 'Alice box' })).data;
    expect(a.instance_id).toMatch(/^ozc-[a-z2-7]{10}$/);
    expect(a.viewer_url).toBe('https://view.example/?token=inst-token');
    expect(a.ready).toBe(true);
    expect((await tool('alice', 'list_computers')).data.computers.map((c: any) => c.instance_id)).toEqual([a.instance_id]);
    expect((await tool('bob', 'list_computers')).data.computers).toEqual([]);
    for (const name of ['get_computer', 'start_computer', 'destroy_computer', 'screenshot']) {
      const r = await tool('bob', name, { instance_id: a.instance_id });
      expect(r.isError).toBe(true);
      expect(r.data.error.reason).toBe('target_unavailable');
    }
    expect((await tool('alice', 'get_computer', { instance_id: a.instance_id })).data.display_name).toBe('Alice box');
  });

  it('proxies calls to the instance with its token, minus instance_id', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    const r = await tool('alice', 'click', { instance_id: a.instance_id, x: 10, y: 20 });
    expect(r).toEqual({ isError: false, data: 'did click' });
    expect(instance.calls.at(-1)).toEqual({ name: 'click', args: { x: 10, y: 20 }, client: 'Name of alice' });
    expect((await tool('alice', 'click', { x: 1, y: 2 })).data.error.reason).toBe('invalid_request');
  });

  it('sends response headers before a slow tool finishes (clients enforce a header deadline)', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    const t0 = Date.now();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PSK}`, 'x-ozwell-user-id': 'alice', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow', arguments: { instance_id: a.instance_id } } }),
    });
    const headersAfter = Date.now() - t0;
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(headersAfter).toBeLessThan(1000);
    expect(await r.text()).toContain('did slow');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
  });

  it('reports stopped computers and starts them', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    expect(a).toMatchObject({ status: 'running', stopped: false });
    provider.all.set(a.instance_id, { ...provider.all.get(a.instance_id)!, status: 'exited', stopped: true, internalUrl: undefined });
    expect((await tool('alice', 'list_computers')).data.computers[0]).toMatchObject({ status: 'exited', stopped: true });
    const r = await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 });
    expect(r.isError).toBe(true);
    expect(r.data.error.reason).toBe('computer_stopped');
    expect(r.data.error.message).toContain(`call start_computer with instance_id "${a.instance_id}"`);
    expect((await tool('alice', 'start_computer', { instance_id: a.instance_id })).data).toMatchObject({ stopped: false, ready: true });
    expect(await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 })).toEqual({ isError: false, data: 'did click' });
  });

  it('checks the provider when a computer answers 503 or refuses connections', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    const set = (patch: Partial<Computer>) => provider.all.set(a.instance_id, { ...provider.all.get(a.instance_id)!, ...patch });
    // the platform stopped it after the orchestrator looked it up
    const proxy = await unavailable(() => set({ status: 'offline', stopped: true }));
    set({ internalUrl: proxy.url });
    const stopped = await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 });
    expect(stopped.data.error.reason).toBe('computer_stopped');
    // still running per the provider: the original error, no start_computer advice
    const busy = await unavailable(() => undefined);
    set({ status: 'running', stopped: false, internalUrl: busy.url });
    const running = await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 });
    expect(running.data.error.reason).toBe('target_unavailable');
    expect(running.data.error.message).toContain('HTTP 503');
    expect(running.data.error.message).not.toContain('start_computer');
    await proxy.app.close();
    await busy.app.close();
    // connection refused (nothing listens there any more)
    set({ internalUrl: proxy.url });
    const refused = await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 });
    expect(refused.data.error.reason).toBe('target_unavailable');
    expect(refused.data.error.message).not.toContain('start_computer');
    const get = provider.get;
    let gets = 0;
    provider.get = async (id) => { const c = await get(id); return ++gets > 1 ? { ...c!, status: 'offline', stopped: true } : c; };
    expect((await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 })).data.error.reason).toBe('computer_stopped');
    provider.get = get;
    set({ stopped: true, status: 'offline' });
    expect((await tool('alice', 'start_computer', { instance_id: a.instance_id })).data.ready).toBe(true);
  });

  it('treats a 503 with a JSON-RPC error body like any 503, and keeps the error if the status check fails', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    const set = (patch: Partial<Computer>) => provider.all.set(a.instance_id, { ...provider.all.get(a.instance_id)!, ...patch });
    const proxy = await rpcUnavailable(() => set({ status: 'offline', stopped: true }));
    set({ internalUrl: proxy.url });
    expect((await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 })).data.error.reason).toBe('computer_stopped');
    set({ status: 'running', stopped: false });
    const get = provider.get;
    let gets = 0;
    provider.get = async (id) => { if (++gets > 1) throw new Error('provider API timed out'); return get(id); };
    const r = await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 });
    provider.get = get;
    await proxy.app.close();
    expect(r.data.error).toMatchObject({ reason: 'target_unavailable', message: expect.stringContaining('HTTP 503') });
    set({ status: 'running', stopped: false, internalUrl: instance.url });
  });

  it('releases the connection of a 503 that keeps streaming its body', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    const set = (patch: Partial<Computer>) => provider.all.set(a.instance_id, { ...provider.all.get(a.instance_id)!, ...patch });
    let closed = false;
    const proxy = Fastify();
    proxy.post('/mcp', async (req, reply) => {
      req.raw.socket.once('close', () => { closed = true; });
      reply.hijack();
      reply.raw.writeHead(503, { 'content-type': 'text/html' });
      const tick = setInterval(() => reply.raw.write('x'.repeat(16_384)), 10);
      reply.raw.once('close', () => clearInterval(tick));
    });
    await proxy.listen({ port: 0, host: '127.0.0.1' });
    set({ status: 'running', stopped: false, internalUrl: `http://127.0.0.1:${(proxy.server.address() as any).port}` });
    expect((await tool('alice', 'click', { instance_id: a.instance_id, x: 1, y: 2 })).data.error.message).toContain('HTTP 503');
    for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
    set({ internalUrl: instance.url });
    await proxy.close();
  });

  it('is not ready while the provider still reports it stopped', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    const c = provider.all.get(a.instance_id)!;
    const start = provider.start;
    // /health already answers, but the platform's status lags behind
    provider.start = async (id) => { const s = { ...c, status: 'offline', stopped: true, internalUrl: instance.url }; provider.all.set(id, s); return s; };
    provider.all.set(a.instance_id, { ...c, status: 'offline', stopped: true });
    setTimeout(() => provider.all.set(a.instance_id, { ...c, status: 'running', stopped: false }), 2000);
    const r = (await tool('alice', 'start_computer', { instance_id: a.instance_id })).data;
    provider.start = start;
    expect(r).toMatchObject({ stopped: false, ready: true });
  });

  it('destroys', async () => {
    const a = (await tool('alice', 'list_computers')).data.computers[0];
    expect((await tool('alice', 'destroy_computer', { instance_id: a.instance_id })).data.ok).toBe(true);
    expect((await tool('alice', 'list_computers')).data.computers).toEqual([]);
  });
});

describe('quota', () => {
  it('refuses create_computer at the per-user limit and lists the existing computers', async () => {
    const provider = memoryProvider(instance.url, 'inst-token');
    const q = await buildServer({ provider, catalog, client: new InstanceClient(), version: 't', psk: PSK, readyTimeoutMs: 5000, maxInstances: 1 });
    await q.listen({ port: 0, host: '127.0.0.1' });
    const prev = base;
    base = `http://127.0.0.1:${(q.server.address() as any).port}`;
    try {
      const tools = (await rpc('carol', 'tools/list')).body.result.tools;
      expect(tools.find((t: any) => t.name === 'create_computer').description).toMatch(/at most 1 computer/);
      const a = (await tool('carol', 'create_computer', { display_name: 'first' })).data;
      const r = await tool('carol', 'create_computer');
      expect(r.isError).toBe(true);
      expect(r.data.error.reason).toBe('quota_exceeded');
      expect(r.data.error.message).toMatch(/destroy_computer/);
      expect(r.data.computers.map((c: any) => [c.instance_id, c.display_name])).toEqual([[a.instance_id, 'first']]);
      expect((await provider.list('carol')).length).toBe(1);
      // Quota is per user.
      expect((await tool('dave', 'create_computer')).isError).toBe(false);
      // Destroying frees it up.
      await tool('carol', 'destroy_computer', { instance_id: a.instance_id });
      expect((await tool('carol', 'create_computer')).isError).toBe(false);
    } finally {
      base = prev;
      await q.close();
    }
  });

  it('is unlimited and unmentioned by default', async () => {
    const tools = (await rpc('alice', 'tools/list')).body.result.tools;
    expect(tools.find((t: any) => t.name === 'create_computer').description).not.toMatch(/at most/);
  });
});

describe('providers', () => {
  it('dispatches on the URI scheme', async () => {
    registerProvider('memtest', (uri) => ({ ...memoryProvider('x', 'y'), scheme: `memtest:${uri.hostname}` }));
    expect((await providerFromUri('memtest://abc')).scheme).toBe('memtest:abc');
    expect((await providerFromUri('docker:///var/run/docker.sock')).scheme).toBe('docker');
    await expect(providerFromUri('nope://x')).rejects.toThrow(/no provider for scheme "nope"/);
  });
  it('docker reports exited containers as stopped and starts them', async () => {
    const state = { Status: 'exited' };
    const started: string[] = [];
    const docker = Fastify();
    docker.get('/containers/:id/json', async (req) => ({
      Name: `/${(req.params as any).id}`, State: state,
      Config: { Labels: { 'org.mieweb.ozwell-computer.managed': 'true', 'org.mieweb.ozwell-computer.owner': 'u-1' }, Env: ['OZWELL_COMPUTER_TOKEN=t'] },
      NetworkSettings: { Networks: state.Status === 'running' ? { bridge: { IPAddress: '172.17.0.9' } } : {} },
    }));
    docker.post('/containers/:id/start', async (req, reply) => {
      started.push((req.params as any).id);
      const already = state.Status === 'running';
      state.Status = 'running';
      return reply.code(already ? 304 : 204).send();
    });
    await docker.listen({ port: 0, host: '127.0.0.1' });
    const p = await providerFromUri(`docker://127.0.0.1:${(docker.server.address() as any).port}`);
    expect(await p.get('ozc-x')).toMatchObject({ status: 'exited', stopped: true, internalUrl: undefined });
    expect(await p.start('ozc-x')).toMatchObject({ status: 'running', stopped: false, internalUrl: 'http://172.17.0.9:8080' });
    await p.start('ozc-x'); // 304
    expect(started).toEqual(['ozc-x', 'ozc-x']);
    await docker.close();
  });
  it('generates DNS-label ids', () => {
    for (let i = 0; i < 50; i++) expect(generateId()).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
  });
  it('proxiedTools leaves the catalog untouched', () => {
    proxiedTools(catalog);
    expect(catalog.find((t) => t.name === 'click')!.inputSchema.required).toEqual(['x', 'y']);
  });
  it('docker passes COMPUTER_FRAME_ANCESTORS to new computers', async () => {
    const created: any[] = [];
    const docker = Fastify();
    docker.post('/containers/create', async (req) => { created.push(req.body); return { Id: 'x' }; });
    docker.post('/containers/:id/start', async (_req, reply) => reply.code(204).send());
    docker.get('/containers/:id/json', async () => ({ Name: '/c', Config: created[0], State: { Status: 'running' } }));
    await docker.listen({ port: 0, host: '127.0.0.1' });
    const port = (docker.server.address() as any).port;
    const p = await providerFromUri(`docker://127.0.0.1:${port}`, { COMPUTER_FRAME_ANCESTORS: 'https://app.ozwell.ai' });
    const c = await p.create({ owner: { id: 'u' } });
    await docker.close();
    expect(created[0].Env).toContain('OZWELL_COMPUTER_FRAME_ANCESTORS=https://app.ozwell.ai');
    expect(created[0].Env).toContain(`OZWELL_COMPUTER_TOKEN=${c.token}`);
  });
});
