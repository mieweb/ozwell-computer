// The gateway lives outside the guest: authenticate first, then acquire a lifecycle
// reference until the entire HTTP response or upgraded connection has finished.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { Computer, Provider } from './providers/types.ts';
import { InstanceError } from './instance-client.ts';

export interface GatewayLifecycle {
  acquire(id: string): Promise<{ computer: Computer; release(): void }>;
}
export interface GatewayOptions {
  provider: Provider;
  lifecycle: GatewayLifecycle;
  /** One complete DNS label must be {id}; paths would break the guest's absolute URLs. */
  publicUrl: string;
  connectTimeoutMs?: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest();
const tokenOk = (expected: string, given: string | null | undefined) =>
  typeof given === 'string' && given.length > 0 && timingSafeEqual(hash(expected), hash(given));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Validate at startup, rather than silently publishing an unreachable viewer URL. */
export function validatePublicUrl(template: string): URL {
  if (template.split('{id}').length !== 2) throw new Error('LIBVIRT_PUBLIC_URL must contain exactly one {id} DNS label');
  // URL() escapes braces in some components; parse a real label then inspect all components.
  const u = new URL(template.replace('{id}', 'ozwell-placeholder'));
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash || !u.hostname.split('.').includes('ozwell-placeholder')) {
    throw new Error('LIBVIRT_PUBLIC_URL must be an http(s) origin with {id} as a complete DNS label');
  }
  return u;
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (part.slice(0, i).trim() !== name) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { return decodeURIComponent(value); } catch { return value; }
  }
}

function authorized(computer: Computer, req: IncomingMessage, url: URL): boolean {
  // A managed guest must have a credential; a missing provider secret is not public access.
  if (!computer.token) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization?.trim() ?? '')?.[1].trim();
  const xToken = req.headers['x-auth-token'];
  if ([url.searchParams.get('token'), bearer, typeof xToken === 'string' ? xToken : undefined,
    cookie(req.headers.cookie, 'ozwell_computer_token')].some((given) => tokenOk(computer.token!, given))) return true;
  // Match the guest's file capability format. HEAD uses a GET signature; PUT has
  // its own signature. Other methods cannot turn a download into a mutation.
  if (!['GET', 'HEAD', 'PUT'].includes(req.method ?? '') || !url.pathname.startsWith('/files/')) return false;
  let path: string;
  try { path = '/' + url.pathname.slice('/files/'.length).split('/').map(decodeURIComponent).join('/'); } catch { return false; }
  const exp = Number(url.searchParams.get('exp'));
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const key = createHash('sha256').update('ozwell-computer:files:').update(computer.token).digest();
  const expected = createHmac('sha256', key).update(`${req.method === 'PUT' ? 'PUT' : 'GET'}\n${path}\n${exp}`).digest('base64url');
  return tokenOk(expected, url.searchParams.get('sig'));
}

function headers(req: IncomingMessage, publicUrl: URL, upgrade = false): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = { ...req.headers };
  const connection = String(result.connection ?? '').split(',').map((s) => s.trim().toLowerCase());
  for (const name of [...hopHeaders, ...connection]) delete result[name];
  result.host = publicUrl.host;
  result['x-forwarded-host'] = publicUrl.host;
  result['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
  result['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  // Never relay an attacker-supplied alternative origin to guest middleware.
  delete result.forwarded;
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = req.headers.upgrade; }
  return result;
}

function responseHeaders(req: IncomingMessage): IncomingHttpHeaders {
  const result = { ...req.headers };
  const connection = String(result.connection ?? '').split(',').map((s) => s.trim().toLowerCase());
  for (const name of [...hopHeaders, ...connection]) delete result[name];
  return result;
}

function send(res: ServerResponse, code: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}
function rejectUpgrade(socket: Duplex, code: number): void {
  if (socket.destroyed) return;
  const text = `${code} ${code === 401 ? 'Unauthorized' : code === 404 ? 'Not Found' : code === 503 ? 'Service Unavailable' : 'Bad Gateway'}`;
  socket.end(`HTTP/1.1 ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

export function createGateway(opts: GatewayOptions) {
  const template = validatePublicUrl(opts.publicUrl);
  let marker = 'ozwell-placeholder';
  while (opts.publicUrl.toLowerCase().includes(marker)) marker += '-x';
  const hostname = new URL(opts.publicUrl.replace('{id}', marker)).hostname;
  const pattern = new RegExp(`^${escapeRe(hostname).replace(marker, '([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)')}$`, 'i');
  const broadPattern = new RegExp(`^${escapeRe(hostname).replace(marker, '([^.]*)')}$`, 'i');
  const httpAgent = new HttpAgent({ keepAlive: true });
  const httpsAgent = new HttpsAgent({ keepAlive: true });
  const aborters = new Set<() => void>();
  let closed = false;

  async function match(req: IncomingMessage): Promise<{ computer: Computer; url: URL; publicUrl: URL } | false | null> {
    const host = req.headers.host;
    if (!host || /[\s,/@\\]/.test(host)) return null;
    let origin: URL, url: URL;
    try {
      origin = new URL(`${template.protocol}//${host}`);
      if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
      url = new URL(req.url ?? '/', origin);
      // Absolute-form requests must not select a different origin than Host.
      if (url.origin !== origin.origin) return null;
    } catch { return null; }
    const found = pattern.exec(origin.hostname);
    if (!found) return broadPattern.test(origin.hostname) ? null : false;
    if (origin.port !== template.port) return null;
    const computer = await opts.provider.get(found[1].toLowerCase());
    if (!computer?.externalUrl) return null;
    const expected = new URL(computer.externalUrl);
    if (expected.origin !== origin.origin || expected.pathname !== '/' || expected.search || expected.hash || expected.username || expected.password) return null;
    return { computer, url, publicUrl: origin };
  }

  function request(computer: Computer, req: IncomingMessage, publicUrl: URL, upgrade = false) {
    if (!computer.internalUrl) throw new Error('Computer has no internal address');
    const target = new URL(computer.internalUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid internal address');
    const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      method: req.method, path: req.url ?? '/', headers: headers(req, publicUrl, upgrade),
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
    });
    // A connection deadline is not a response/stream deadline: PTY, VNC and SSE
    // connections can remain active indefinitely without an arbitrary timeout.
    const timer = setTimeout(() => outgoing.destroy(new Error('Guest connection timed out')), opts.connectTimeoutMs ?? 10_000);
    timer.unref();
    const clear = () => clearTimeout(timer);
    outgoing.once('socket', (socket) => {
      socket.setKeepAlive(true, 30_000);
      if (!socket.connecting) clear();
      else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', clear);
    });
    outgoing.once('error', clear);
    outgoing.once('close', clear);
    return outgoing;
  }

  function blocked(path: string): boolean {
    try { path = decodeURIComponent(path); } catch { return true; }
    return /^\/api\/v1\/lifecycle\/(prepare|resume)(\/|$)/.test(path);
  }
  const passive = (req: IncomingMessage, path: string) => ['GET', 'HEAD'].includes(req.method ?? '') &&
    ['/health', '/api/v1/metrics', '/api/v1/lifecycle'].includes(path);

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let matched: Awaited<ReturnType<typeof match>>;
    try { matched = await match(req); } catch { send(res, 503, 'Computer unavailable'); return true; }
    if (matched === false) return false;
    if (!matched) { send(res, 404, 'Computer not found'); return true; }
    const { computer, url, publicUrl } = matched;
    if (!authorized(computer, req, url)) {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'" });
        res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Computer login</title><h1>Computer login</h1><form action="/" method="get"><label>Access token <input type="password" name="token" required autocomplete="off"></label><button>Connect</button></form>');
      } else send(res, 401, 'Missing or invalid computer token');
      return true;
    }
    if (blocked(url.pathname)) { send(res, 403, 'Lifecycle controls are private'); return true; }
    if (closed) { send(res, 503, 'Gateway is closing'); return true; }
    req.socket.setKeepAlive(true, 30_000);
    let lease: Awaited<ReturnType<GatewayLifecycle['acquire']>> | undefined;
    try {
      if (passive(req, url.pathname)) {
        if (computer.stopped || computer.hibernated) { send(res, 503, 'Computer is hibernated'); return true; }
      } else lease = await opts.lifecycle.acquire(computer.id);
      if (closed || res.destroyed || req.aborted) { lease?.release(); if (closed) send(res, 503, 'Gateway is closing'); return true; }
      const upstream = request(lease?.computer ?? computer, req, publicUrl);
      let finished = false;
      const done = () => { if (finished) return; finished = true; aborters.delete(abort); lease?.release(); };
      const abort = () => { upstream.destroy(); res.destroy(); done(); };
      aborters.add(abort);
      res.once('finish', done);
      res.once('close', () => { upstream.destroy(); done(); });
      req.once('aborted', abort);
      req.once('error', abort);
      res.once('error', abort);
      upstream.once('error', () => { send(res, 502, 'Guest connection failed'); done(); });
      upstream.once('response', (response) => {
        if (res.destroyed) { response.destroy(); return; }
        res.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders(response));
        response.once('error', () => { res.destroy(); done(); });
        response.once('aborted', () => { res.destroy(); done(); });
        response.pipe(res);
      });
      req.pipe(upstream);
      return true;
    } catch (error) {
      lease?.release();
      const navigation = req.method === 'GET' && ['/', '/index.html'].includes(url.pathname) && req.headers.accept?.includes('text/html');
      if (error instanceof InstanceError && error.reason === 'computer_starting' && navigation && !res.headersSent && !res.destroyed && !res.writableEnded) {
        // A first boot can exceed the controller's bounded wait. Only a browser
        // navigation retries automatically; never replay a submitted request body.
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3', refresh: '3' });
        res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Computer starting</title><p>Your computer is starting. Reconnecting shortly.</p>');
      } else send(res, 503, 'Computer unavailable');
      return true;
    }
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    socket.pause();
    // Errors can arrive while provider lookup or restore is still pending.
    socket.once('error', () => {});
    let matched: Awaited<ReturnType<typeof match>>;
    try { matched = await match(req); } catch { rejectUpgrade(socket, 503); return true; }
    if (matched === false) { socket.resume(); return false; }
    if (!matched) { rejectUpgrade(socket, 404); return true; }
    if (!authorized(matched.computer, req, matched.url)) { rejectUpgrade(socket, 401); return true; }
    if (blocked(matched.url.pathname)) { rejectUpgrade(socket, 401); return true; }
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') { rejectUpgrade(socket, 502); return true; }
    req.socket.setKeepAlive(true, 30_000);
    let lease: Awaited<ReturnType<GatewayLifecycle['acquire']>> | undefined;
    try {
      if (closed) throw new Error('Gateway closed');
      lease = await opts.lifecycle.acquire(matched.computer.id);
      if (socket.destroyed || closed) { lease.release(); rejectUpgrade(socket, 503); return true; }
      const upstream = request(lease.computer, req, matched.publicUrl, true);
      let tunnel: Duplex | undefined;
      let finished = false;
      const done = () => { if (finished) return; finished = true; aborters.delete(abort); lease?.release(); };
      const abort = () => { upstream.destroy(); tunnel?.destroy(); socket.destroy(); done(); };
      aborters.add(abort);
      socket.once('error', abort);
      // Upgraded HTTP sockets allow half-open TCP streams. A WebSocket peer
      // ending its input has disconnected; close both halves to avoid a lease
      // surviving forever while the upstream waits for another frame.
      socket.once('end', () => { upstream.destroy(); tunnel?.destroy(); socket.destroy(); });
      socket.once('close', () => { upstream.destroy(); tunnel?.destroy(); done(); });
      upstream.once('error', () => { rejectUpgrade(socket, 502); done(); });
      upstream.once('response', (response) => { response.destroy(); rejectUpgrade(socket, [401, 503].includes(response.statusCode ?? 0) ? response.statusCode! : 502); done(); });
      upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
        tunnel = upstreamSocket;
        if (socket.destroyed || finished) { upstreamSocket.destroy(); done(); return; }
        const responseLines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
        for (let i = 0; i < response.rawHeaders.length; i += 2) responseLines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
        socket.write(responseLines.join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.once('error', abort);
        upstreamSocket.once('close', () => { socket.destroy(); done(); });
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        socket.resume();
      });
      upstream.end();
      return true;
    } catch { lease?.release(); rejectUpgrade(socket, 503); return true; }
  }

  async function close(): Promise<void> {
    closed = true;
    for (const abort of [...aborters]) abort();
    httpAgent.destroy();
    httpsAgent.destroy();
  }
  return { handler, upgrade, close };
}
