import { afterEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { createGateway, validatePublicUrl } from '../src/gateway.ts';
import { buildServer } from '../src/server.ts';
import { IdleController } from '../src/lifecycle.ts';
import { InstanceClient, InstanceError } from '../src/instance-client.ts';
import type { Computer, Provider } from '../src/providers/types.ts';

const token = 'guest-secret', host = 'ozc-test.computers.test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function setup(upstreamHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.end('guest'); }, acquireError: () => Error | undefined = () => undefined) {
  const upstream = createServer(upstreamHandler), upstreamPort = await listen(upstream);
  const computer: Computer = { id: 'ozc-test', owner: 'owner', status: 'running', stopped: false, token, internalUrl: `http://127.0.0.1:${upstreamPort}`, externalUrl: `http://${host}` };
  let acquisitions = 0, active = 0, restores = 0, restoring: Promise<void> | undefined;
  const provider: Provider = {
    scheme: 'memory', async get(id) { return id === computer.id ? { ...computer } : null; },
    async list() { return [computer]; }, async create() { return computer; }, async start() { return computer; }, async destroy() {},
  };
  const gateway = createGateway({ provider, publicUrl: 'http://{id}.computers.test', connectTimeoutMs: 1000, lifecycle: {
    async acquire() {
      acquisitions++;
      const error = acquireError(); if (error) throw error;
      active++;
      if (computer.stopped) {
        restoring ??= (async () => { restores++; await sleep(30); computer.stopped = false; computer.hibernated = false; })();
        await restoring;
      }
      let released = false;
      return { computer, release() { if (!released) { released = true; active--; } } };
    },
  } });
  const front = createServer((req, res) => { void gateway.handler(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end('orchestrator'); } }); });
  front.on('upgrade', (req, socket, head) => { void gateway.upgrade(req, socket, head).then((handled) => { if (!handled) socket.destroy(); }); });
  const port = await listen(front);
  cleanup.push(async () => { await gateway.close(); await close(front); await close(upstream); });
  return { gateway, port, upstream, computer, provider, get acquisitions() { return acquisitions; }, get active() { return active; }, get restores() { return restores; } };
}
function call(port: number, path = '/', headers: IncomingHttpHeaders = {}, method = 'GET', body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', path, method, headers: { host, authorization: `Bearer ${token}`, ...headers } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() })); res.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
}
function signedPath(path: string, method: 'GET' | 'PUT', exp = Math.floor(Date.now() / 1000) + 60) {
  const key = createHash('sha256').update('ozwell-computer:files:').update(token).digest();
  const sig = createHmac('sha256', key).update(`${method}\n${path}\n${exp}`).digest('base64url');
  return `/files${path.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`;
}

describe('always-on computer gateway', () => {
  it('validates origin templates before serving', () => {
    for (const value of ['https://computers.test', 'https://prefix-{id}.test', 'https://{id}.test/view', 'https://u:p@{id}.test', 'https://{id}.test?token=x', 'https://{id}.test/#x', 'ftp://{id}.test', 'https://{id}.{id}.test']) expect(() => validatePublicUrl(value)).toThrow();
    expect(validatePublicUrl('https://{id}.computers.test:9443').port).toBe('9443');
  });
  it('authenticates every credential source before waking and serves a login form without waking', async () => {
    const h = await setup(); h.computer.stopped = true; h.computer.hibernated = true;
    const login = await call(h.port, '/', { authorization: '' });
    expect(login.status).toBe(200); expect(login.body).toContain('name="token"'); expect(login.body).toContain('method="get"');
    expect((await call(h.port, '/api/v1/info', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call(h.port, '/static/app.js', { authorization: '' })).status).toBe(401); expect(h.acquisitions).toBe(0);
    for (const [path, headers] of [
      ['/?token=guest-secret', { authorization: '' }], ['/', { authorization: `Bearer ${token}` }],
      ['/', { authorization: '', 'x-auth-token': token }], ['/', { authorization: '', cookie: `other=a; ozwell_computer_token=${token}` }],
    ] as Array<[string, IncomingHttpHeaders]>) expect((await call(h.port, path, headers)).body).toBe('guest');
    expect(h.acquisitions).toBe(4); expect(h.restores).toBe(1); expect(h.active).toBe(0);
  });
  it('rejects unknown guests, ports and untrusted absolute-form origins without waking', async () => {
    const h = await setup();
    for (const value of ['missing.computers.test', 'bad_id.computers.test', `${host}:9443`]) expect((await call(h.port, '/', { host: value })).status).toBe(404);
    expect((await call(h.port, 'http://attacker.test/')).status).toBe(404);
    h.computer.externalUrl = 'http://different.computers.test'; expect((await call(h.port)).status).toBe(404); expect(h.acquisitions).toBe(0);
    expect((await call(h.port, '/health', { host: 'orchestrator.test' })).body).toBe('orchestrator');
  });
  it('polls without waking or extending activity, and keeps prepare/resume private', async () => {
    let hits = 0; const h = await setup((req, res) => {
      hits++;
      if (['/health', '/api/v1/metrics', '/api/v1/lifecycle'].includes(req.url!)) expect(req.headers.connection).toBe('close');
      res.end('poll');
    });
    for (const path of ['/health', '/api/v1/metrics', '/api/v1/lifecycle']) expect((await call(h.port, path)).status).toBe(200);
    expect(hits).toBe(3); expect(h.acquisitions).toBe(0); h.computer.stopped = true; h.computer.hibernated = true;
    for (const path of ['/health', '/api/v1/metrics', '/api/v1/lifecycle']) expect((await call(h.port, path)).status).toBe(503);
    for (const path of ['/api/v1/lifecycle/prepare', '/api/v1/lifecycle/resume', '/api/v1/lifecycle/%70repare']) expect((await call(h.port, path, {}, 'POST')).status).toBe(403);
    expect(hits).toBe(3); expect(h.acquisitions).toBe(0);
    expect((await call(h.port, '/api/v1/lifecycle/leases/build', {}, 'PUT', '{"ttl_ms":1000}')).status).toBe(200); expect(h.acquisitions).toBe(1);
  });
  it('validates signed file capabilities before restoration and rejects unsupported methods', async () => {
    const h = await setup(); h.computer.stopped = true; const download = signedPath('/tmp/a b.txt', 'GET');
    expect((await call(h.port, `${download}x`, { authorization: '' })).status).toBe(401);
    expect((await call(h.port, signedPath('/tmp/a b.txt', 'GET', 1), { authorization: '' })).status).toBe(401);
    for (const method of ['DELETE', 'PUT']) expect((await call(h.port, download, { authorization: '' }, method)).status).toBe(401);
    expect(h.acquisitions).toBe(0);
    expect((await call(h.port, download, { authorization: '' })).status).toBe(200);
    expect((await call(h.port, download, { authorization: '' }, 'HEAD')).status).toBe(200);
    expect((await call(h.port, signedPath('/tmp/upload', 'PUT'), { authorization: '' }, 'PUT', 'payload')).status).toBe(200);
    expect(h.acquisitions).toBe(3); expect(h.restores).toBe(1);
  });
  it('streams a POST once, preserving the public origin and multiple cookies', async () => {
    let posts = 0, seen = ''; const h = await setup((req, res) => {
      posts++; req.on('data', (chunk: Buffer) => { seen += chunk.toString(); }); req.on('end', () => {
        expect(req.headers.host).toBe(host); expect(req.headers['x-forwarded-host']).toBe(host); expect(req.headers['x-forwarded-proto']).toBe('http');
        expect(req.headers.forwarded).toBeUndefined(); expect(req.headers.origin).toBe(`http://${host}`);
        res.writeHead(201, { 'set-cookie': ['first=a; Path=/', 'second=b; Path=/'] }); res.end(seen);
      });
    });
    const result = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = request({ port: h.port, host: '127.0.0.1', path: '/api/v1/files', method: 'POST', headers: { host, authorization: `Bearer ${token}`, origin: `http://${host}`, forwarded: 'host=attacker.test;proto=https', 'x-forwarded-proto': 'https' } }, (res) => {
        let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }); req.on('error', reject); req.write('first'); setTimeout(() => req.end('-second'), 20);
    });
    expect(result.status).toBe(201); expect(result.body).toBe('first-second'); expect(posts).toBe(1);
    expect(result.headers['set-cookie']).toEqual(['first=a; Path=/', 'second=b; Path=/']); expect(h.active).toBe(0);
  });
  it('streams before completion, retaining the reference until finish or client cancellation', async () => {
    let finish: (() => void) | undefined;
    const h = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); finish = () => res.end('data: last\n\n'); });
    await new Promise<void>((resolve, reject) => {
      const req = request({ port: h.port, host: '127.0.0.1', headers: { host, authorization: `Bearer ${token}` } }, (res) => {
        res.once('data', (chunk) => { expect(chunk.toString()).toBe('data: first\n\n'); expect(h.active).toBe(1); finish!(); }); res.on('end', resolve); res.on('error', reject);
      }); req.on('error', reject); req.end();
    }); expect(h.active).toBe(0);
    await new Promise<void>((resolve, reject) => {
      const req = request({ port: h.port, host: '127.0.0.1', headers: { host, authorization: `Bearer ${token}` } }, (res) => {
        res.once('data', () => { expect(h.active).toBe(1); res.destroy(); resolve(); });
      }); req.on('error', reject); req.end();
    }); await sleep(20); expect(h.active).toBe(0);
  });
  it('shares restoration across concurrent requests and releases every reference', async () => {
    const h = await setup(); h.computer.stopped = true; h.computer.hibernated = true;
    expect((await Promise.all(Array.from({ length: 8 }, () => call(h.port)))).every((r) => r.status === 200)).toBe(true);
    expect(h.acquisitions).toBe(8); expect(h.restores).toBe(1); expect(h.active).toBe(0);
  });
  it('never replays a POST after an upstream disconnect', async () => {
    let hits = 0; const h = await setup((req) => { hits++; req.socket.destroy(); });
    expect((await call(h.port, '/api/v1/mutate', {}, 'POST', 'once')).status).toBe(502); expect(hits).toBe(1); expect(h.active).toBe(0);
  });
  it('tunnels an upgrade and payload, holding its reference until full socket closure', async () => {
    const h = await setup(); h.computer.stopped = true;
    h.upstream.on('upgrade', (req, socket, head) => {
      expect(req.headers.host).toBe(host); expect(req.headers.origin).toBe(`http://${host}`);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); if (head.length) socket.write(head);
      socket.on('data', (chunk) => socket.write(chunk)); socket.on('end', () => socket.end());
    });
    const socket = createConnection({ port: h.port, host: '127.0.0.1' }); cleanup.push(async () => { socket.destroy(); });
    await new Promise<void>((resolve, reject) => {
      let received = ''; socket.on('error', reject); socket.on('data', (chunk) => {
        received += chunk.toString(); if (received.includes('tunnel-payload')) { expect(h.active).toBe(1); resolve(); }
      }); socket.once('connect', () => socket.write(`GET /websockify?token=${token} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://${host}\r\n\r\ntunnel-payload`));
    }); expect(h.restores).toBe(1); socket.destroy(); await sleep(20); expect(h.active).toBe(0);
  });
  it('denies unauthorized upgrades before waking and releases failed upstream handshakes', async () => {
    const h = await setup((_req, res) => { res.writeHead(401); res.end(); }); h.computer.stopped = true;
    async function handshake(credential: string) {
      return new Promise<string>((resolve, reject) => {
        const socket = createConnection({ port: h.port, host: '127.0.0.1' }); let text = '';
        socket.on('error', reject); socket.on('data', (chunk) => { text += chunk; }); socket.on('end', () => resolve(text));
        socket.once('connect', () => socket.write(`GET /websockify${credential} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      });
    }
    expect(await handshake('?token=wrong')).toContain('401 Unauthorized'); expect(h.acquisitions).toBe(0);
    expect(await handshake(`?token=${token}`)).toContain('401 Unauthorized'); expect(h.acquisitions).toBe(1); expect(h.active).toBe(0);
  });
  it('routes real Fastify listener traffic before body parsing and keeps orchestrator authentication separate', async () => {
    let guestBody = '', starts = 0;
    const h = await setup((req, res) => {
      if (req.url === '/health') { res.writeHead(204); res.end(); return; }
      if (req.url?.startsWith('/api/v1/lifecycle')) { req.resume(); res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      req.on('data', (chunk) => { guestBody += chunk; }); req.on('end', () => res.end(guestBody));
    });
    h.computer.stopped = true; h.computer.hibernated = true;
    let lock = Promise.resolve();
    h.provider.listAll = async () => [{ ...h.computer }];
    h.provider.withLock = async <T,>(_id: string, fn: () => Promise<T>) => {
      const prior = lock; let release!: () => void; lock = new Promise<void>((resolve) => { release = resolve; });
      await prior; try { return await fn(); } finally { release(); }
    };
    h.provider.hibernate = async () => { h.computer.stopped = true; h.computer.hibernated = true; return h.computer; };
    h.provider.start = async () => { starts++; h.computer.stopped = false; h.computer.hibernated = false; return h.computer; };
    const lifecycle = new IdleController(h.provider, { idleMs: 0 });
    const app = await buildServer({ provider: h.provider, lifecycle, gatewayUrl: 'http://{id}.computers.test', catalog: [], client: new InstanceClient(), version: 'test', psk: 'orchestrator-secret' });
    await app.listen({ port: 0, host: '127.0.0.1' }); cleanup.push(async () => { await app.close(); });
    const port = (app.server.address() as { port: number }).port;
    expect((await call(port, '/api/v1/submit', { 'content-type': 'application/json' }, 'POST', 'not JSON, forwarded verbatim')).body).toBe('not JSON, forwarded verbatim');
    expect(starts).toBe(1);
    expect((await call(port, '/health', { host: 'orchestrator.test', authorization: '' })).status).toBe(204);
    expect((await call(port, '/mcp', { host: 'orchestrator.test' }, 'POST', '{}')).status).toBe(401);
    expect((await call(port, '/api/v1/lifecycle/resume', {}, 'POST', '{}')).status).toBe(403);
  });
  it('offers a browser refresh while starting without forwarding or exposing credentials, then connects once ready', async () => {
    let failure: Error | undefined = new InstanceError('computer_starting', 'private startup diagnostics');
    let forwarded = 0;
    const h = await setup((_req, res) => { forwarded++; res.end('ready desktop'); }, () => failure);
    const url = `/?token=${token}`;
    const unauthenticated = await call(h.port, '/', { authorization: 'Bearer wrong', accept: 'text/html' });
    expect(unauthenticated.headers.refresh).toBeUndefined(); expect(unauthenticated.body).toContain('Computer login'); expect(h.acquisitions).toBe(0);
    const waiting = await call(h.port, url, { accept: 'text/html' });
    expect(waiting.status).toBe(503); expect(waiting.headers['content-type']).toContain('text/html');
    expect(waiting.headers['cache-control']).toBe('no-store'); expect(waiting.headers['retry-after']).toBe('3'); expect(waiting.headers.refresh).toBe('3');
    expect(waiting.body).toContain('Your computer is starting. Reconnecting shortly.');
    expect(waiting.body).not.toContain(token); expect(waiting.body).not.toContain('private startup diagnostics'); expect(waiting.body).not.toContain('<script');
    expect(forwarded).toBe(0); expect(h.active).toBe(0);
    failure = undefined;
    const ready = await call(h.port, url, { accept: 'text/html' });
    expect(ready.status).toBe(200); expect(ready.body).toBe('ready desktop'); expect(forwarded).toBe(1); expect(h.active).toBe(0);
  });
  it('never refreshes POSTs, API calls, non-HTML requests or errors other than starting', async () => {
    let failure = new InstanceError('computer_starting', 'boot wait');
    let forwarded = 0; const h = await setup((_req, res) => { forwarded++; res.end(); }, () => failure);
    for (const [path, method, accept] of [['/', 'POST', 'text/html'], ['/api/v1/info', 'GET', 'text/html'], ['/index.html', 'GET', 'application/json']]) {
      const response = await call(h.port, path, { accept }, method, method === 'POST' ? 'one submission' : undefined);
      expect(response.status).toBe(503); expect(response.headers.refresh).toBeUndefined(); expect(response.headers['content-type']).toContain('text/plain');
    }
    failure = new InstanceError('target_unavailable', 'repair needed');
    const unavailable = await call(h.port, '/', { accept: 'text/html' });
    expect(unavailable.status).toBe(503); expect(unavailable.headers.refresh).toBeUndefined(); expect(forwarded).toBe(0);
  });
  it('releases a pending restore reference when shutdown happens before acquisition completes', async () => {
    const h = await setup(); h.computer.stopped = true;
    const response = call(h.port);
    while (h.acquisitions === 0) await sleep(1);
    expect(h.active).toBe(1); await h.gateway.close();
    // Closing a gateway during the restore cannot forward to the guest or leak
    // the reference once the lifecycle controller finishes its serialized wake.
    const result = await response;
    expect(result.status).toBe(503); expect(h.active).toBe(0);
  });
  it('releases references when shutdown closes active streams', async () => {
    const h = await setup((_req, res) => { res.writeHead(200); res.write('open'); });
    const req = request({ port: h.port, host: '127.0.0.1', headers: { host, authorization: `Bearer ${token}` } }); req.on('error', () => {});
    await new Promise<void>((resolve) => { req.once('response', (res) => { res.on('error', () => {}); res.once('data', resolve); }); req.end(); });
    expect(h.active).toBe(1); await h.gateway.close(); expect(h.active).toBe(0);
  });
});
