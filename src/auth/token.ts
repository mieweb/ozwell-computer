import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison that does not leak length differences. */
export function tokenEquals(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface ResolvedToken {
  token: string;
  source: 'config' | 'file' | 'generated';
}

/**
 * Resolve the PSK: explicit config wins; otherwise read the token file; otherwise
 * generate one and persist it (mode 0600) so it survives restarts.
 */
export async function resolveToken(explicit: string | undefined, tokenFile: string): Promise<ResolvedToken> {
  if (explicit) return { token: explicit, source: 'config' };
  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim();
    if (existing) return { token: existing, source: 'file' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = generateToken();
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, token + '\n', { mode: 0o600 });
  return { token, source: 'generated' };
}

/** HMAC key for signed URLs, derived from the PSK so rotating the token invalidates them. */
export function deriveKey(token: string, purpose: string): Buffer {
  return createHash('sha256').update(`ozwell-computer:${purpose}:`).update(token).digest();
}
