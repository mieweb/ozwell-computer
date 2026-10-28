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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ozwell-desktop: sign in</title><link rel="stylesheet" href="/static/viewer.css"></head>
<body class="login">
<form method="get" action="/" class="login-box">
  <h1>ozwell-desktop</h1>
  ${failed ? '<p class="error">That token was not accepted.</p>' : '<p>Enter the access token to view this desktop.</p>'}
  <input type="password" name="token" autocomplete="current-password" placeholder="token" autofocus required>
  <button type="submit">Open</button>
</form></body></html>`);
  return reply;
}

export function viewerHtml(title: string, viewOnly: boolean) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/static/viewer.css"></head>
<body data-view-only="${viewOnly ? '1' : '0'}">
<div id="toolbar">
  <span id="status">connecting…</span>
  <span id="perf" title="Container resource use (from /api/v1/metrics)"></span>
  <button id="btn-update" hidden></button>
  <span class="spacer"></span>
  <button id="btn-cad" title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</button>
  <button id="btn-super" title="Send Super">Super</button>
  <button id="btn-alttab" title="Send Alt+Tab">Alt+Tab</button>
  <button id="btn-clip" title="Clipboard">Clipboard</button>
  <label title="Ignore my input"><input type="checkbox" id="chk-viewonly"> view only</label>
  <select id="sel-scale" title="Scaling">
    <option value="fit">fit</option><option value="remote">1:1</option>
  </select>
  <button id="btn-full" title="Fullscreen">Fullscreen</button>
  <span id="roster"></span>
</div>
<div id="clip-panel" hidden>
  <textarea id="clip-text" rows="4" placeholder="Remote clipboard (edit and press Send)"></textarea>
  <button id="clip-send">Send</button><button id="clip-refresh">Refresh</button>
</div>
<div id="screen-wrap"><div id="screen"></div><div id="overlay"></div><div id="toast" hidden></div></div>
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
