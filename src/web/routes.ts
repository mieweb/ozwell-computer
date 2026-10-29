import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../server.js';

/** The viewer build id that web/vite.config.ts wrote next to the assets, or null when the viewer isn't built. */
export const webBuild = (staticDir: string) => {
  try {
    return readFileSync(join(staticDir, 'build-id'), 'utf8').trim();
  } catch (e) {
    // Not built, or removed by a rebuild in progress.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

export function contentSecurityPolicy(frameAncestors: string[]) {
  return "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; "
    + ['frame-ancestors', "'self'", ...frameAncestors].join(' ');
}

export function nativeHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ozwell-computer: native Mac</title><link rel="stylesheet" href="/static/native.css"></head>
<body><main>
<header><h1>Native Mac desktop</h1><button id="refresh" type="button">Refresh screenshot</button></header>
<p>This pilot controls this Mac through the API and MCP. The preview updates when you refresh it.</p>
<form id="login" method="get" action="/" hidden>
<h2>Sign in</h2><p id="login-message">Enter the access token to view this desktop.</p>
<label for="token">Access token</label>
<input id="token" type="password" name="token" autocomplete="current-password" required>
<button type="submit">Open</button></form>
<p id="status" role="status">Connecting…</p>
<img id="snapshot" alt="Screenshot of the native Mac desktop" hidden>
<p><a href="/api/docs">API documentation</a> · <a href="/api/v1/capabilities">Desktop capabilities</a></p>
</main><script type="module" src="/static/native.js"></script></body></html>`;
}

// Both shells load their data from the authenticated API. Vite builds the React
// X11 viewer and packages the native preview assets into dist/web/static.
export default async function webRoutes(app: FastifyInstance, ctx: AppContext) {
  const csp = contentSecurityPolicy(ctx.config.frameAncestors);
  const page = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', csp);
    return ctx.desktop.kind === 'macos'
      ? reply.type('text/html; charset=utf-8').send(nativeHtml())
      : reply.sendFile('index.html', { cacheControl: false });
  };
  app.get('/', { schema: { hide: true } }, page);
  app.get('/index.html', { schema: { hide: true } }, page);
  app.get('/favicon.ico', { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());
}
