import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { BrowserBridge } from '../../src/browser/bridge.js';
import { FrameReader, browserSocketPath, frame } from '../../src/browser/protocol.js';
import { makeApp } from '../helpers.js';

const auth = { authorization: 'Bearer secret-token' };
const log = pino({ level: 'silent' });

describe('browser bridge protocol', () => {
  it('frames are a little-endian length and JSON, and survive any chunking', () => {
    const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: 'ü' })]);
    expect(bytes.readUInt32LE(0)).toBe(7);
    const r = new FrameReader();
    const got = [...bytes].flatMap((b) => r.push(Buffer.from([b]))).map((x) => JSON.parse(x.toString()));
    expect(got).toEqual([{ a: 1 }, { b: 'ü' }]);
  });

  it('rejects oversized frames', () => {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(0xffffffff);
    expect(() => new FrameReader().push(h)).toThrow(/exceeds/);
  });

  it('the socket lives in the session runtime directory, shared with Firefox', () => {
    expect(browserSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe('/run/user/1000/ozwell-computer/browser.sock');
    expect(browserSocketPath({}, 1001)).toBe('/run/user/1001/ozwell-computer/browser.sock');
  });
});

describe('browser bridge socket', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const sock = () => { const d = mkdtempSync(join(tmpdir(), 'oz-sock-')); dirs.push(d); return join(d, 'browser.sock'); };

  it('refuses to take over a socket another server is listening on, and leaves it working', async () => {
    const path = sock();
    const first = new BrowserBridge(path, log);
    await first.listen();
    const second = new BrowserBridge(path, log);
    await expect(second.listen()).rejects.toThrow(/another server is listening/);
    await second.close();
    const ino = statSync(path).ino;
    expect(await new Promise((r) => { const c = connect(path, () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })).toBe(true);
    await first.close();
    expect(existsSync(path)).toBe(false);
    expect(ino).toBeGreaterThan(0);
  });

  it('of servers starting together, exactly one listens', async () => {
    const path = sock();
    const bridges = Array.from({ length: 5 }, () => new BrowserBridge(path, log));
    const results = await Promise.allSettled(bridges.map((b) => b.listen()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/another server is listening/);
    const winner = bridges[results.findIndex((r) => r.status === 'fulfilled')];
    expect(statSync(path).isSocket()).toBe(true);
    for (const b of bridges) await b.close();
    expect(existsSync(path)).toBe(false);
    // ...and once it is gone, the next one can.
    const next = new BrowserBridge(path, log);
    await next.listen();
    await next.close();
    expect(winner).toBeDefined();
  });

  it('replaces a stale socket, but not a file that is not a socket', async () => {
    const path = sock();
    // A server that died without closing leaves its socket behind.
    spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`]);
    expect(statSync(path).isSocket()).toBe(true);
    const b = new BrowserBridge(path, log);
    await b.listen();
    await b.close();
    writeFileSync(path, 'not a socket');
    await expect(new BrowserBridge(path, log).listen()).rejects.toThrow(/not a socket/);
  });

  it('on close removes only its own socket, not one that replaced it', async () => {
    const path = sock();
    const b = new BrowserBridge(path, log);
    await b.listen();
    rmSync(path);
    const other = createServer();
    await new Promise<void>((r) => other.listen(path, () => r()));
    await b.close();
    expect(statSync(path).isSocket()).toBe(true);
    await new Promise<void>((r) => other.close(() => r()));
  });
});

interface WebExtCookie {
  name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean;
  sameSite: string; session: boolean; expirationDate?: number; storeId: string;
}

/** A stand-in for the native host plus extension, with a cookie store that behaves like Firefox's. */
class FakeFirefox {
  readonly calls: { method: string; params: any }[] = [];
  readonly jar = new Map<string, WebExtCookie>();
  fail: string | null = null;
  silent = false;
  private socket: Socket | null = null;

  connect(path: string): Promise<void> {
    return new Promise((resolve) => {
      const s = connect(path, () => resolve());
      const reader = new FrameReader();
      s.on('data', (chunk: Buffer) => { for (const b of reader.push(chunk)) this.answer(s, JSON.parse(b.toString())); });
      this.socket = s;
    });
  }

  disconnect() { this.socket?.destroy(); }

  /** Before each answer, send a reply that a previous server's request with the same counter would get. */
  stale = false;
  /** Before each answer, send replies that aren't one: valid JSON of the wrong shape, and not JSON. */
  junk = false;

  private answer(s: Socket, { id, method, params }: { id: string; method: string; params: any }) {
    this.calls.push({ method, params });
    if (this.junk && method !== 'browser.info') {
      for (const j of [null, 5, 'x', [id], { id: 7 }, { id, error: { toString: null } }]) s.write(frame(j));
      s.write(Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{{{')]));
    }
    if (this.stale && method !== 'browser.info') s.write(frame({ id: id.replace(/^[^.]*/, 'old-server'), result: [{ name: 'stale' }] }));
    if (method === 'browser.info') return s.write(frame({ id, result: { name: 'Firefox', version: '153.0' } }));
    if (this.silent) return;
    if (this.fail) return s.write(frame({ id, error: this.fail }));
    s.write(frame({ id, result: this.handle(method, params) }));
  }

  private handle(method: string, p: any): unknown {
    const host = (u: string) => new URL(u).hostname;
    if (method === 'cookies.getAll') {
      return [...this.jar.values()].filter((c) => {
        const d = c.domain.replace(/^\./, '');
        if (p.name !== undefined && c.name !== p.name) return false;
        if (p.domain !== undefined && d !== p.domain && !d.endsWith(`.${p.domain}`)) return false;
        if (p.url !== undefined) { const h = host(p.url); if (!(h === d || (!c.hostOnly && h.endsWith(`.${d}`)))) return false; }
        return true;
      });
    }
    if (method === 'cookies.set') {
      const domain = p.domain ?? host(p.url);
      const key = `${domain}|${p.name}|${p.path}`;
      if (p.expirationDate !== undefined && p.expirationDate < Date.now() / 1000) { this.jar.delete(key); return null; }
      const c: WebExtCookie = {
        name: p.name, value: p.value, domain, hostOnly: p.domain === undefined, path: p.path, secure: p.secure, httpOnly: p.httpOnly ?? false,
        sameSite: p.sameSite ?? 'unspecified', session: p.expirationDate === undefined, storeId: 'firefox-default',
        ...(p.expirationDate !== undefined ? { expirationDate: p.expirationDate } : {}),
      };
      this.jar.set(key, c);
      return c;
    }
    throw new Error(`unexpected ${method}`);
  }
}

describe('browser cookie API', () => {
  let dir: string;
  let bridge: BrowserBridge;
  let app: FastifyInstance;
  let ff: FakeFirefox;
  let running = false;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oz-browser-'));
    bridge = new BrowserBridge(join(dir, 'run', 'browser.sock'), log, { browserRunning: async () => running, connectWaitMs: 1500, timeoutMs: 500 });
    await bridge.listen();
    ({ app } = await makeApp({}, 'secret-token', null, bridge));
  });
  afterEach(async () => {
    ff?.disconnect();
    running = false;
    for (let i = 0; i < 50 && bridge.info(); i++) await new Promise((r) => setTimeout(r, 10));
  });
  afterAll(async () => {
    await app.close();
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const req = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
  const connected = async () => {
    ff = new FakeFirefox();
    await ff.connect(bridge.path);
    for (let i = 0; i < 50 && !bridge.info(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(bridge.info()).toEqual({ name: 'Firefox', version: '153.0' });
  };

  it('the socket is private to the server\'s user', () => {
    expect(statSync(bridge.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
  });

  it('without Firefox, calls fail at once with target_unavailable and capabilities say why', async () => {
    const t0 = Date.now();
    const r = await req('GET', '/api/v1/browser/cookies');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatchObject({ reason: 'target_unavailable', message: expect.stringContaining('launch_app') });
    const caps = (await req('GET', '/api/v1/capabilities')).json();
    expect(caps.features.browser).toMatchObject({ available: false, limitation: expect.stringContaining('not running') });
  });

  it('while Firefox starts, a call waits for its extension to connect', async () => {
    running = true;
    const pending = req('GET', '/api/v1/browser/cookies');
    await new Promise((r) => setTimeout(r, 200));
    await connected();
    const r = await pending;
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ cookies: [] });
    expect((await req('GET', '/api/v1/capabilities')).json().features.browser).toEqual({ available: true });
  });

  it('a connection made while the process check runs is used at once', async () => {
    for (const found of [true, false]) {
      running = found;
      const slow = bridge['opts'].browserRunning;
      bridge['opts'].browserRunning = async () => { await connected(); return found; };
      try {
        const t0 = Date.now();
        const r = await req('GET', '/api/v1/browser/cookies');
        expect(r.statusCode).toBe(200);
        expect(Date.now() - t0).toBeLessThan(1000);
      } finally {
        bridge['opts'].browserRunning = slow;
        ff.disconnect();
        for (let i = 0; i < 50 && bridge.info(); i++) await new Promise((res) => setTimeout(res, 10));
      }
    }
  });

  it('ignores replies to a previous server\'s requests, which a surviving host may still deliver', async () => {
    await connected();
    ff.stale = true;
    const r = await req('GET', '/api/v1/browser/cookies?domain=nothing.example');
    expect(r.json()).toEqual({ cookies: [] });
  });

  it('survives replies that are not one (null, other JSON, not JSON)', async () => {
    await connected();
    ff.junk = true;
    // The first well-formed reply with the request's id answers it: here, an error.
    const r = await req('GET', '/api/v1/browser/cookies');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('Firefox: {"toString":null}');
    ff.junk = false;
    expect((await req('GET', '/api/v1/browser/cookies')).statusCode).toBe(200);
  });

  it('uses hosts in the form Firefox stores them (127.1 is 127.0.0.1)', async () => {
    await connected();
    const set = (await req('PUT', '/api/v1/browser/cookies', { name: 'ip', value: 'x', domain: '127.1' })).json();
    expect(set).toMatchObject({ domain: '127.0.0.1', host_only: true });
    expect((await req('GET', '/api/v1/browser/cookies?domain=127.1')).json().cookies.map((c: any) => c.name)).toEqual(['ip']);
    expect((await req('DELETE', '/api/v1/browser/cookies?name=ip&domain=0x7f000001')).json().deleted.map((c: any) => c.domain)).toEqual(['127.0.0.1']);
  });

  it('replies are never cached: they carry credentials', async () => {
    await connected();
    await req('PUT', '/api/v1/browser/cookies', { name: 'sid', value: 'v', domain: 'example.net' });
    for (const r of [
      await req('GET', '/api/v1/browser/cookies'),
      await req('PUT', '/api/v1/browser/cookies', { name: 'sid', value: 'v', domain: 'example.net' }),
      await req('DELETE', '/api/v1/browser/cookies?name=sid&domain=example.net'),
    ]) expect(r.headers['cache-control']).toBe('no-store');
  });

  it('sets domain and host-only cookies, and reads back the one it set', async () => {
    await connected();
    const dom = await req('PUT', '/api/v1/browser/cookies', { name: 'sid', value: 'd', domain: '.Example.com', secure: true, http_only: true, same_site: 'none', expires: 4e9 });
    expect(dom.statusCode).toBe(200);
    expect(dom.json()).toEqual({ name: 'sid', value: 'd', domain: '.example.com', host_only: false, path: '/', secure: true, http_only: true, same_site: 'none', expires: 4e9 });
    expect(ff.calls.find((c) => c.method === 'cookies.set')?.params).toEqual({
      url: 'https://example.com/', name: 'sid', value: 'd', path: '/', secure: true, domain: '.example.com', httpOnly: true, sameSite: 'no_restriction', expirationDate: 4e9,
    });
    const host = await req('PUT', '/api/v1/browser/cookies', { name: 'sid', value: 'h', domain: 'example.com', path: '/app' });
    expect(host.json()).toEqual({ name: 'sid', value: 'h', domain: 'example.com', host_only: true, path: '/app', secure: false, http_only: false, same_site: 'unspecified', expires: null });
    expect(ff.calls.filter((c) => c.method === 'cookies.set').at(-1)?.params).toEqual({ url: 'http://example.com/app', name: 'sid', value: 'h', path: '/app', secure: false, httpOnly: false });

    // A cookie as listed can be set again as is.
    const again = await req('PUT', '/api/v1/browser/cookies', { ...host.json(), value: 'h2' });
    expect(again.json()).toEqual({ ...host.json(), value: 'h2' });
    expect(ff.calls.filter((c) => c.method === 'cookies.set').at(-1)?.params).toEqual({ url: 'http://example.com/app', name: 'sid', value: 'h2', path: '/app', secure: false, httpOnly: false });

    const all = (await req('GET', '/api/v1/browser/cookies?domain=.example.com')).json().cookies;
    expect(all.map((c: any) => `${c.domain}${c.path}=${c.value}`)).toEqual(['.example.com/=d', 'example.com/app=h2']);
    expect(ff.calls.at(-1)).toEqual({ method: 'cookies.getAll', params: { domain: 'example.com' } });
    await req('GET', '/api/v1/browser/cookies?name=sid&url=https://example.com/');
    expect(ff.calls.at(-1)?.params).toEqual({ name: 'sid', url: 'https://example.com/' });
  });

  it('deletes by exact domain, on every path or one', async () => {
    await connected();
    for (const [domain, path] of [['.example.org', '/'], ['example.org', '/'], ['example.org', '/a']]) {
      await req('PUT', '/api/v1/browser/cookies', { name: 'sid', value: 'x', domain, path });
    }
    const one = (await req('DELETE', '/api/v1/browser/cookies?name=sid&domain=example.org&path=/a')).json();
    expect(one.deleted.map((c: any) => `${c.domain}${c.path}`)).toEqual(['example.org/a']);
    const rest = (await req('DELETE', '/api/v1/browser/cookies?name=sid&domain=example.org')).json();
    expect(rest.deleted.map((c: any) => `${c.domain}${c.path}`)).toEqual(['example.org/']);
    expect((await req('GET', '/api/v1/browser/cookies?domain=example.org')).json().cookies.map((c: any) => c.domain)).toEqual(['.example.org']);
    expect((await req('DELETE', '/api/v1/browser/cookies?name=nope&domain=example.org')).json()).toEqual({ deleted: [] });
    // Paths may contain spaces (RFC 6265), so such a cookie round-trips too.
    const spaced = (await req('PUT', '/api/v1/browser/cookies', { name: 'sp', value: 'x', domain: 'example.org', path: '/account settings' })).json();
    expect(spaced.path).toBe('/account settings');
    const gone = (await req('DELETE', `/api/v1/browser/cookies?name=sp&domain=example.org&path=${encodeURIComponent('/account settings')}`)).json();
    expect(gone.deleted.map((c: any) => c.path)).toEqual(['/account settings']);
  });

  it.each([
    [{ name: 'a', value: 'b', domain: 'https://example.com' }, /domain must be a host name/],
    [{ name: 'a', value: 'b', domain: 'example.com', path: 'x' }, /path must start/],
    [{ name: 'a', value: 'b', domain: 'example.com', path: '/a\nb' }, /control characters/],
    [{ name: 'a b', value: 'b', domain: 'example.com' }, /name must be/],
    [{ name: 'a', value: 'b;c', domain: 'example.com' }, /value must not/],
    [{ name: 'a', value: 'b', domain: 'example.com', same_site: 'none' }, /requires secure/],
    [{ name: 'a', value: 'b', domain: '.example.com', host_only: true }, /host_only disagrees/],
  ])('rejects %j before calling Firefox', async (body, message) => {
    await connected();
    const r = await req('PUT', '/api/v1/browser/cookies', body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(message);
    expect(ff.calls.map((c) => c.method)).toEqual(['browser.info']);
  });

  it('reports Firefox\'s errors as invalid_request', async () => {
    await connected();
    ff.fail = 'Permission denied to set cookie';
    const r = await req('PUT', '/api/v1/browser/cookies', { name: 'a', value: 'b', domain: 'example.com' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ reason: 'invalid_request', message: 'Firefox: Permission denied to set cookie' });
  });

  it('fails calls that Firefox does not answer, or drops', async () => {
    await connected();
    ff.silent = true;
    expect((await req('GET', '/api/v1/browser/cookies')).json().error.message).toMatch(/did not answer/);
    const pending = req('GET', '/api/v1/browser/cookies');
    await new Promise((r) => setTimeout(r, 50));
    ff.disconnect();
    expect((await pending).json().error).toMatchObject({ reason: 'target_unavailable', message: expect.stringMatching(/disconnected/) });
  });
});
