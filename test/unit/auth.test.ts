import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers.js';
import { authenticate, extractCredentials, parseCookies, redactUrl } from '../../src/auth/plugin.js';
import { tokenEquals } from '../../src/auth/token.js';

const TOKEN = 'secret-token';

describe('auth primitives', () => {
  it('compares tokens in constant time, any length', () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
    expect(tokenEquals(TOKEN, 'x')).toBe(false);
    expect(tokenEquals(TOKEN, '')).toBe(false);
    expect(tokenEquals(TOKEN, undefined)).toBe(false);
  });
  it('extracts credentials in priority order', () => {
    const c = extractCredentials({
      url: '/x?token=q',
      headers: { authorization: 'Bearer b', 'x-auth-token': 'h', cookie: 'a=1; ozwell_computer_token=c' },
    } as any);
    expect(c.map((x) => x[0])).toEqual(['query', 'bearer', 'x-auth-token', 'cookie']);
    expect(authenticate('c', { url: '/x?token=q', headers: { cookie: 'ozwell_computer_token=c' } } as any)).toBe('cookie');
  });
  it('parses cookies and redacts urls', () => {
    expect(parseCookies('a=1; b="2"')).toEqual({ a: '1', b: '2' });
    expect(redactUrl('/api?token=abc&x=1')).toBe('/api?token=REDACTED&x=1');
    expect(redactUrl('/plain')).toBe('/plain');
  });
});

describe('auth matrix', () => {
  let app: FastifyInstance;
  beforeAll(async () => { ({ app } = await makeApp()); });
  afterAll(async () => { await app.close(); });

  it('no token → 401 JSON with WWW-Authenticate', async () => {
    const r = await app.inject({ url: '/api/v1/capabilities' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect(r.json().error.reason).toBe('unauthenticated');
  });
  it('wrong token → 401', async () => {
    const r = await app.inject({ url: '/api/v1/capabilities', headers: { authorization: 'Bearer nope' } });
    expect(r.statusCode).toBe(401);
  });
  it('?token on a page → 302 + HttpOnly cookie, token stripped', async () => {
    const r = await app.inject({ url: '/?token=' + TOKEN + '&foo=1' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/?foo=1');
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain('ozwell_computer_token=' + TOKEN);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
  });
  it('adds Secure behind TLS proxy', async () => {
    const r = await app.inject({ url: '/?token=' + TOKEN, headers: { 'x-forwarded-proto': 'https' } });
    expect(String(r.headers['set-cookie'])).toContain('Secure');
  });
  it('?token on an API route → 200 (no redirect)', async () => {
    const r = await app.inject({ url: '/api/v1/capabilities?token=' + TOKEN });
    expect(r.statusCode).toBe(200);
  });
  it.each([
    ['bearer', { authorization: 'Bearer ' + TOKEN }],
    ['x-auth-token', { 'x-auth-token': TOKEN }],
    ['cookie', { cookie: 'ozwell_computer_token=' + TOKEN }],
  ])('%s → 200', async (_n, headers) => {
    const r = await app.inject({ url: '/api/v1/capabilities', headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().auth).toBe('token');
  });
  it('/ without credentials shows login page', async () => {
    const r = await app.inject({ url: '/' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('name="token"');
  });
  it('/health and /novnc are exempt', async () => {
    expect((await app.inject({ url: '/health' })).statusCode).toBe(503); // no X in unit tests, but not 401
    expect((await app.inject({ url: '/novnc/core/rfb.js' })).statusCode).toBe(200);
  });
  it('openapi requires auth and documents routes', async () => {
    expect((await app.inject({ url: '/api/v1/openapi.json' })).statusCode).toBe(401);
    const r = await app.inject({ url: '/api/v1/openapi.json', headers: { authorization: 'Bearer ' + TOKEN } });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json().paths)).toContain('/api/v1/screenshot');
  });
  it('X-dependent routes return target_unavailable without a display', async () => {
    const r = await app.inject({ url: '/api/v1/windows', headers: { authorization: 'Bearer ' + TOKEN } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.reason).toBe('target_unavailable');
  });
  it('unknown routes use the error shape', async () => {
    const r = await app.inject({ url: '/api/v1/nope', headers: { authorization: 'Bearer ' + TOKEN } });
    expect(r.json().error.reason).toBe('target_unavailable');
  });
  it('schema violations → 400 invalid_request', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/input/pointer', headers: { authorization: 'Bearer ' + TOKEN }, payload: { action: 'fly' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.reason).toBe('invalid_request');
  });
});

describe('auth disabled', () => {
  let app: FastifyInstance;
  beforeAll(async () => { ({ app } = await makeApp({}, null)); });
  afterAll(async () => { await app.close(); });
  it('everything → 200 and capabilities report disabled', async () => {
    const r = await app.inject({ url: '/api/v1/capabilities' });
    expect(r.statusCode).toBe(200);
    expect(r.json().auth).toBe('disabled');
    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
  });
});
