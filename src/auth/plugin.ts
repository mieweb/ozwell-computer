import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { tokenEquals } from './token.js';

export const COOKIE_NAME = 'ozwell_computer_token';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export type CredentialSource = 'query' | 'bearer' | 'x-auth-token' | 'cookie';

/** Collect candidate credentials in priority order. */
export function extractCredentials(req: Pick<FastifyRequest, 'headers' | 'url'>): Array<[CredentialSource, string]> {
  const out: Array<[CredentialSource, string]> = [];
  const q = new URL(req.url, 'http://x').searchParams.get('token');
  if (q) out.push(['query', q]);
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) out.push(['bearer', m[1].trim()]);
  }
  const xat = req.headers['x-auth-token'];
  if (typeof xat === 'string' && xat) out.push(['x-auth-token', xat]);
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookie) out.push(['cookie', cookie]);
  return out;
}

export function authenticate(token: string, req: Pick<FastifyRequest, 'headers' | 'url'>): CredentialSource | null {
  for (const [src, val] of extractCredentials(req)) if (tokenEquals(token, val)) return src;
  return null;
}

/** Remove `token` (and signed-URL `sig`) from a URL for logging. */
export function redactUrl(url: string): string {
  if (!/[?&](token|sig)=/.test(url)) return url;
  const u = new URL(url, 'http://x');
  for (const k of ['token', 'sig']) if (u.searchParams.has(k)) u.searchParams.set(k, 'REDACTED');
  return u.pathname + u.search;
}

export function isSecure(req: FastifyRequest): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(xf) ? xf[0] : xf;
  if (proto) return proto.split(',')[0].trim().toLowerCase() === 'https';
  return req.protocol === 'https';
}

function isExempt(req: FastifyRequest): boolean {
  const path = req.url.split('?')[0];
  if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) return true;
  if (path.startsWith('/novnc/') && (req.method === 'GET' || req.method === 'HEAD')) return true;
  if (path.startsWith('/static/') && (req.method === 'GET' || req.method === 'HEAD')) return true;
  if (path === '/favicon.ico') return true;
  // Signed file URLs carry their own HMAC authorisation; the route verifies it.
  if (path.startsWith('/files/')) return true;
  return false;
}

/** Paths where a browser lands; ?token there is converted to a cookie + redirect. */
function isBrowserPage(req: FastifyRequest): boolean {
  if (req.method !== 'GET') return false;
  if (req.headers.upgrade) return false;
  const path = req.url.split('?')[0];
  return !(path.startsWith('/api/v1') || path === '/mcp' || path === '/websockify');
}

/** The SPA shell; it holds no data, and shows its login view when the API answers 401. */
function isShell(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers.upgrade) return false;
  const path = req.url.split('?')[0];
  return path === '/' || path === '/index.html';
}

export interface AuthOptions {
  token: string | null; // null => disabled
}

export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  app.decorateRequest('authSource', null);
  if (opts.token === null) return;
  const token = opts.token;

  app.addHook('onRequest', async (req, reply) => {
    if (isExempt(req)) return;
    const src = authenticate(token, req);
    if (src) {
      (req as FastifyRequest & { authSource: CredentialSource | null }).authSource = src;
      if (src === 'query' && isBrowserPage(req)) {
        const u = new URL(req.url, 'http://x');
        u.searchParams.delete('token');
        const cookie = [
          `${COOKIE_NAME}=${encodeURIComponent(token)}`,
          'HttpOnly',
          // Lax, not Strict: a ?token= link opened from another site (chat, email, the
          // Ozwell workspace) is a cross-site navigation, and browsers withhold Strict
          // cookies for its whole redirect chain, so the redirect below lands on the login
          // page. Lax still blocks the cookie on cross-site subrequests and POSTs.
          'SameSite=Lax',
          'Path=/',
          ...(isSecure(req) ? ['Secure'] : []),
        ].join('; ');
        reply.header('set-cookie', cookie).header('cache-control', 'no-store').redirect(u.pathname + u.search, 302);
        return reply;
      }
      return;
    }
    if (isShell(req)) return;
    const e = new ApiError('unauthenticated', 'missing or invalid token');
    reply.code(401).header('www-authenticate', 'Bearer').send(e.toBody());
    return reply;
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    authSource: CredentialSource | null;
  }
}
