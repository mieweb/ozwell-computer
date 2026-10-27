import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { ApiError } from '../errors.js';

/** Resolve a user path inside `root`, rejecting traversal outside it. */
export function safePath(root: string, p: string | undefined): string {
  if (typeof p !== 'string' || p.length === 0) throw new ApiError('invalid_request', 'path is required');
  if (p.includes('\0')) throw new ApiError('invalid_request', 'path contains NUL');
  const base = resolve(root);
  const full = isAbsolute(p) ? resolve(base, '.' + sep + normalize(p)) : resolve(base, p);
  if (base !== sep && full !== base && !full.startsWith(base + sep)) throw new ApiError('permission_denied', 'path escapes the filesystem root');
  return full;
}

export type SignMethod = 'GET' | 'PUT';

function payload(method: SignMethod, path: string, exp: number) {
  return `${method}\n${path}\n${exp}`;
}

export function signPath(key: Buffer, method: SignMethod, path: string, exp: number): string {
  return createHmac('sha256', key).update(payload(method, path, exp)).digest('base64url');
}

export function signedUrl(key: Buffer, method: SignMethod, path: string, ttlS: number, now = Date.now()): { url: string; expires_at: number } {
  const exp = Math.floor(now / 1000) + ttlS;
  const sig = signPath(key, method, path, exp);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return { url: `/files${encoded.startsWith('/') ? '' : '/'}${encoded}?exp=${exp}&sig=${sig}`, expires_at: exp };
}

export function verifySignature(key: Buffer, method: SignMethod, path: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
  const want = Buffer.from(signPath(key, method, path, exp));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Parse a single HTTP byte range. Returns null when absent/unsatisfiable-as-full. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number, end: number;
  if (m[1] === '') {
    if (m[2] === '') return 'invalid';
    const n = parseInt(m[2], 10);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}
