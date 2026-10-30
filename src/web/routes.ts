import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../server.js';

/** The viewer build id that web/vite.config.ts wrote next to the assets, or null when the viewer isn't built. */
export const webBuild = (staticDir: string) => {
  const file = join(staticDir, 'build-id');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
};

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
