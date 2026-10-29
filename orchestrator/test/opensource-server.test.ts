import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { OpensourceServerProvider } from '../src/providers/opensource-server.ts';
import { providerFromUri } from '../src/providers/index.ts';

/** Fake opensource-server API: just enough of /api/v1 for the provider. */
async function fakeOs() {
  const containers: any[] = [];
  const requests: any[] = [];
  let nextId = 100;
  const app = Fastify();
  app.addHook('onRequest', async (req, reply) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer os-key') return reply.code(401).send({ error: { code: 'unauthorized', message: 'bad key' } });
  });
  app.get('/api/v1/users', async () => ({ data: [{ uid: 'asmith', mail: 'Alice@Example.com' }, { uid: 'bob', mail: 'bob@example.com' }] }));
  app.get('/api/v1/sites/:site/containers', async (req) => {
    const host = (req.query as any).hostname;
    return { data: containers.filter((c) => c.site === (req.params as any).site && (!host || c.hostname === host)) };
  });
  app.post('/api/v1/sites/:site/containers', async (req, reply) => {
    const b = req.body as any;
    const svc = Object.values<any>(b.services)[0];
    const c = {
      id: nextId++, site: (req.params as any).site, hostname: b.hostname, owner: b.username ?? 'svc-account', status: 'creating', ipv4Address: '10.0.0.5',
      template: b.template, environmentVars: Object.fromEntries(b.environmentVars.map((e: any) => [e.key, e.value])),
      httpEntries: [{ port: svc.internalPort, externalUrl: `https://${svc.externalHostname}.example.org` }], _svc: svc,
    };
    containers.push(c);
    return reply.code(201).send({ data: { containerId: c.id, jobId: 1, hostname: c.hostname, status: 'creating' } });
  });
  app.put('/api/v1/sites/:site/containers/:id', async (req) => {
    const c = containers.find((x) => String(x.id) === (req.params as any).id);
    c._put = req.body;
    const b = req.body as any;
    if (b.environmentVars) c.environmentVars = Object.fromEntries(b.environmentVars.map((e: any) => [e.key, e.value]));
    if (b.restart) c.status = 'running';
    return { data: { containerId: c.id, jobId: 2, dnsWarnings: [], pendingRestart: false, message: 'Container is restarting' } };
  });
  app.delete('/api/v1/sites/:site/containers/:id', async (req) => {
    const i = containers.findIndex((c) => String(c.id) === (req.params as any).id);
    containers.splice(i, 1);
    return { data: { deleted: true, dnsWarnings: [] } };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, containers, requests, host: `127.0.0.1:${(app.server.address() as any).port}` };
}

let os: Awaited<ReturnType<typeof fakeOs>>;
const env = { OPENSOURCE_SERVER_API_KEY: 'os-key' };
const make = (q: string) => new OpensourceServerProvider(new URL(`opensource-server://${os.host}?tls=0&site=1&domain=7&${q}`), env);
beforeAll(async () => { os = await fakeOs(); });
afterAll(async () => { await os.app.close(); });

describe('opensource-server provider', () => {
  it('validates its URI', () => {
    expect(() => new OpensourceServerProvider(new URL('opensource-server://h?domain=1'), env)).toThrow(/site/);
    expect(() => new OpensourceServerProvider(new URL('opensource-server://h?site=1'), env)).toThrow(/domain/);
    expect(() => new OpensourceServerProvider(new URL('opensource-server://h?site=1&domain=1'), {})).toThrow(/API_KEY/);
    expect(() => make('owner=nope')).toThrow(/owner/);
  });

  it('is selected by scheme', async () => {
    expect((await providerFromUri(`opensource-server://${os.host}?site=1&domain=2`, env)).scheme).toBe('opensource-server');
  });

  it('creates a tagged container with a public viewer service and reads it back statelessly', async () => {
    const p = make('');
    const c = await p.create({ owner: { id: 'u-1', email: 'alice@example.com', name: 'Alice' }, displayName: 'Box' });
    expect(c.id).toMatch(/^ozc-[a-z2-7]{10}$/);
    const raw = os.containers.find((x) => x.hostname === c.id);
    expect(raw.template).toBe('ghcr.io/mieweb/ozwell-computer:latest');
    expect(raw.owner).toBe('svc-account'); // owner=tag: not attributed to a user
    expect(raw._svc).toEqual({ type: 'http', internalPort: 8080, externalHostname: c.id, externalDomainId: 7, authRequired: false });
    expect(raw.environmentVars).toMatchObject({ OZWELL_ORCHESTRATOR_MANAGED: 'true', OZWELL_ORCHESTRATOR_OWNER: 'u-1', OZWELL_ORCHESTRATOR_OWNER_NAME: 'Alice', OZWELL_ORCHESTRATOR_DISPLAY_NAME: 'Box' });
    expect(c).toMatchObject({ owner: 'u-1', displayName: 'Box', status: 'creating', externalUrl: `https://${c.id}.example.org`, internalUrl: `https://${c.id}.example.org` });
    expect(c.token).toBe(raw.environmentVars.OZWELL_COMPUTER_TOKEN);
    // a fresh provider instance sees the same thing (no in-memory state)
    expect(await make('').get(c.id)).toEqual(c);
    expect((await make('internal=ip').get(c.id))!.internalUrl).toBe('http://10.0.0.5:8080');
  });

  it('scopes lists to the owner and ignores unmanaged containers', async () => {
    const p = make('');
    await p.create({ owner: { id: 'u-2' } });
    os.containers.push({ id: 999, site: '1', hostname: 'someones-server', environmentVars: {} });
    expect((await p.list('u-1')).map((c) => c.owner)).toEqual(['u-1']);
    expect((await p.list('u-2')).length).toBe(1);
    expect(await p.get('someones-server')).toBeNull();
    expect(await p.get('../../x')).toBeNull();
  });

  it('owner=email attributes the container to the matching user', async () => {
    const c = await make('owner=email').create({ owner: { id: 'u-3', email: 'alice@example.com' } });
    expect(os.containers.find((x) => x.hostname === c.id).owner).toBe('asmith');
    await expect(make('owner=email').create({ owner: { id: 'u-4', email: 'nobody@example.com' } })).rejects.toThrow(/no opensource-server account/);
    await expect(make('owner=email').create({ owner: { id: 'u-5' } })).rejects.toThrow(/X-Ozwell-User-Email/);
  });

  it('reports offline containers as stopped and starts them with a restart job', async () => {
    const p = make('');
    const c = await p.create({ owner: { id: 'u-6' } });
    const raw = os.containers.find((x) => x.hostname === c.id);
    raw.status = 'offline';
    expect(await p.get(c.id)).toMatchObject({ status: 'offline', stopped: true });
    expect(await p.start(c.id)).toMatchObject({ status: 'running', stopped: false });
    expect(raw._put.restart).toBe(true);
    expect(raw.environmentVars).toMatchObject({ OZWELL_ORCHESTRATOR_OWNER: 'u-6', OZWELL_ORCHESTRATOR_START_REQUESTED: expect.any(String) });
    expect(raw.environmentVars.OZWELL_COMPUTER_TOKEN).toMatch(/\S/);
    await expect(p.start('ozc-doesnotexi')).rejects.toThrow(/not found/);
  });

  it('enqueues one restart job for concurrent or repeated starts', async () => {
    const p = make('');
    const c = await p.create({ owner: { id: 'u-9' } });
    const raw = os.containers.find((x) => x.hostname === c.id);
    raw.status = 'offline';
    const puts = () => os.requests.filter((r) => r.method === 'PUT' && r.url.endsWith(`/containers/${raw.id}`)).length;
    await Promise.all([p.start(c.id), p.start(c.id)]);
    expect(puts()).toBe(1);
    // the job hasn't brought it up yet: a retry (from any orchestrator) waits for that job
    raw.status = 'offline';
    expect(await make('').start(c.id)).toMatchObject({ stopped: true });
    expect(puts()).toBe(1);
    // a running computer is never restarted
    raw.status = 'running';
    raw.environmentVars.OZWELL_ORCHESTRATOR_START_REQUESTED = '2000-01-01T00:00:00Z';
    await p.start(c.id);
    expect(puts()).toBe(1);
  });

  it('destroys by hostname via the numeric id, and surfaces API errors', async () => {
    const p = make('');
    const [c] = await p.list('u-2');
    await p.destroy(c.id);
    expect(await p.get(c.id)).toBeNull();
    expect(os.requests.some((r) => r.method === 'DELETE' && /\/containers\/\d+$/.test(r.url))).toBe(true);
    await p.destroy('ozc-doesnotexi'); // no-op
    const bad = new OpensourceServerProvider(new URL(`opensource-server://${os.host}?tls=0&site=1&domain=7`), { OPENSOURCE_SERVER_API_KEY: 'wrong' });
    await expect(bad.list('u-1')).rejects.toThrow(/bad key/);
  });
  it('passes COMPUTER_FRAME_ANCESTORS to new computers', async () => {
    const p = new OpensourceServerProvider(new URL(`opensource-server://${os.host}?tls=0&site=1&domain=7`),
      { ...env, COMPUTER_FRAME_ANCESTORS: 'https://app.ozwell.ai' });
    const c = await p.create({ owner: { id: 'u-fa' } });
    const raw = os.containers.find((x) => x.hostname === c.id);
    expect(raw.environmentVars.OZWELL_COMPUTER_FRAME_ANCESTORS).toBe('https://app.ozwell.ai');
    const plain = await make('').create({ owner: { id: 'u-fa' } });
    expect(os.containers.find((x) => x.hostname === plain.id).environmentVars).not.toHaveProperty('OZWELL_COMPUTER_FRAME_ANCESTORS');
  });
});
