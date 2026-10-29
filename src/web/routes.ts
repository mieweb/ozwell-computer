import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../server.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'";

export function loginPage(_req: FastifyRequest, reply: FastifyReply, failed: boolean) {
  reply
    .code(401)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', CSP)
    .send(`<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ozwell-computer: sign in</title><link rel="stylesheet" href="/static/login.css"></head>
<body class="login">
<form method="get" action="/" class="login-box">
  <h1>ozwell-computer</h1>
  ${failed ? '<p class="error">That token was not accepted.</p>' : '<p>Enter the access token to view this desktop.</p>'}
  <input type="password" name="token" autocomplete="current-password" placeholder="token" autofocus required>
  <button type="submit">Open</button>
</form></body></html>`);
  return reply;
}

// The React viewer (web/) mounts on #root; Vite builds it to /static/viewer.{js,css}.
export function viewerHtml(title: string, viewOnly: boolean) {
  return `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/static/viewer.css"></head>
<body data-view-only="${viewOnly ? '1' : '0'}">
<div id="root"></div>
<script type="module" src="/static/viewer.js"></script>
</body></html>`;
}

export default async function webRoutes(app: FastifyInstance, ctx: AppContext) {
  const page = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', CSP)
      .send(viewerHtml(`desktop ${ctx.desktop.x.displayName}`, ctx.config.viewOnly));
  app.get('/', { schema: { hide: true } }, page);
  app.get('/index.html', { schema: { hide: true } }, page);
  app.get('/favicon.ico', { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());
}
