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
function memoryProvider(url: string, token: string): Provider {
  const all = new Map<string, Computer>();
  return {
    scheme: 'memory',
    async list(owner) { return [...all.values()].filter((c) => c.owner === owner); },
    async get(id) { return all.get(id) ?? null; },
    async create({ owner, displayName }) {
      const c: Computer = { id: generateId(), owner: owner.id, ownerName: owner.name, displayName, status: 'running', internalUrl: url, externalUrl: 'https://view.example', token };
      all.set(c.id, c);
      return c;
    },
    async destroy(id) { all.delete(id); },
  };
}

let instance: Awaited<ReturnType<typeof fakeInstance>>;
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
  app = await buildServer({ provider: memoryProvider(instance.url, 'inst-token'), catalog, client: new InstanceClient(), version: 't', psk: PSK, readyTimeoutMs: 5000 });
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
    expect(tools.map((t: any) => t.name)).toEqual(['list_computers', 'create_computer', 'get_computer', 'destroy_computer', 'screenshot', 'slow', 'click']);
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
    for (const name of ['get_computer', 'destroy_computer', 'screenshot']) {
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
