import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
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

  private answer(s: Socket, { id, method, params }: { id: number; method: string; params: any }) {
    this.calls.push({ method, params });
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
  });

  it.each([
    [{ name: 'a', value: 'b', domain: 'https://example.com' }, /domain must be a host name/],
    [{ name: 'a', value: 'b', domain: 'example.com', path: 'x' }, /path must start/],
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
