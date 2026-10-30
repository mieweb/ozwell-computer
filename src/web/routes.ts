import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../server.js';

/** Identifies the viewer build: index.html names Vite's content-hashed assets. Falls back when the viewer isn't built. */
export const webBuild = (indexHtml: string, fallback: string) =>
  existsSync(indexHtml) ? createHash('sha256').update(readFileSync(indexHtml)).digest('base64url').slice(0, 16) : fallback;

export function contentSecurityPolicy(frameAncestors: string[]) {
  return "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; "
    + ['frame-ancestors', "'self'", ...frameAncestors].join(' ');
}

// The React app (web/, built by Vite into dist/web/static) loads its data from the API, so
// the shell holds nothing secret and is served with or without credentials.
export default async function webRoutes(app: FastifyInstance, ctx: AppContext) {
  const csp = contentSecurityPolicy(ctx.config.frameAncestors);
  const page = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', csp)
      .sendFile('index.html', { cacheControl: false });
  app.get('/', { schema: { hide: true } }, page);
  app.get('/index.html', { schema: { hide: true } }, page);
  app.get('/favicon.ico', { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());
}
