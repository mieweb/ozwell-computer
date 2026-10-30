import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import type { AppContext } from '../server.js';
import { m } from '../metrics.js';
import { bounds, errors, media, ok, prop, record, roster, windowInfo, windowRef } from './schemas.js';
import { eventStreams, openSse } from './sse.js';

const idParams = { type: 'object', properties: { id: prop('string', windowRef) }, required: ['id'] };
const epochQuery = {
  type: 'object',
  properties: { epoch: prop('integer', 'Epoch from the window listing; fails with stale_handle if the id now names a different window', { minimum: 0 }) },
};
const launched = record('The process was started', { pid: prop('integer', 'Process id of the detached child') });
const windowActions = {
  activate: 'Raise and focus a window',
  minimize: 'Minimize a window',
  maximize: 'Maximize a window',
  restore: 'Un-minimize and un-maximize a window',
  close: 'Ask a window to close (like clicking its close button)',
};

export function launchDetached(display: string, command: string, args: string[] = [], env: Record<string, string> = {}, cwd?: string) {
  return new Promise<{ pid: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      cwd: cwd || process.env.HOME || '/',
      env: { ...process.env, DISPLAY: display, ...env },
    });
    child.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new ApiError('path_not_found', `command not found: ${command}`) : e));
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid! }); });
  });
}

export default async function windowRoutes(app: FastifyInstance, ctx: AppContext, build: () => string | null) {
  const { desktop, config } = ctx;
  const wm = () => desktop.ctl().windows;

  app.get('/api/v1/windows', {
    schema: {
      tags: ['windows'], summary: 'List windows', description: 'Top-level application windows in stacking order (bottom first); panels and desktop windows are excluded.',
      response: { 200: record('Open windows', { windows: prop('array', 'Windows', { items: windowInfo }) }), ...errors },
    },
  }, async () => ({ windows: await wm().list() }));

  app.get('/api/v1/windows/:id', {
    schema: {
      tags: ['windows'], summary: 'Get a window', params: idParams, querystring: epochQuery,
      response: { 200: windowInfo, ...errors },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const wid = await wm().resolve(id, (req.query as any).epoch);
    return wm().info(wid);
  });

  for (const [action, summary] of Object.entries(windowActions) as [keyof typeof windowActions, string][]) {
    app.post(`/api/v1/windows/:id/${action}`, {
      schema: { tags: ['windows'], summary, params: idParams, querystring: epochQuery, response: { 200: ok, ...errors } },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const w = wm();
      const wid = await w.resolve(id, (req.query as any).epoch);
      await w[action](wid);
      return { ok: true };
    });
  }

  app.put('/api/v1/windows/:id/bounds', {
    schema: {
      tags: ['windows'], summary: 'Move and/or resize a window',
      description: 'Omitted fields are left unchanged. A maximized window is restored first.',
      params: idParams, querystring: epochQuery,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          x: prop('integer', 'New left edge in screen pixels'), y: prop('integer', 'New top edge in screen pixels'),
          width: prop('integer', 'New width', { minimum: 1 }), height: prop('integer', 'New height', { minimum: 1 }),
        },
      },
      response: {
        200: record('Bounds after the change', { ok: prop('boolean', 'Always true'), bounds: { ...bounds, description: 'Window rectangle ~100 ms after the request' } }),
        ...errors,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const w = wm();
    const wid = await w.resolve(id, (req.query as any).epoch);
    await w.setBounds(wid, req.body as any);
    await new Promise((r) => setTimeout(r, 100));
    return { ok: true, bounds: await w.bounds(wid) };
  });

  app.post('/api/v1/apps/launch', {
    schema: {
      tags: ['apps'], summary: 'Launch an application',
      description: 'Starts a detached process on the desktop (not through a shell). Disabled when OZWELL_COMPUTER_EXEC=false.',
      body: {
        type: 'object', required: ['command'], additionalProperties: false,
        properties: {
          command: prop('string', 'Executable name or path, e.g. xterm', { minLength: 1 }),
          args: prop('array', 'Arguments', { items: { type: 'string' } }),
          env: prop('object', 'Extra environment variables', { additionalProperties: { type: 'string' } }),
          cwd: prop('string', 'Working directory (default $HOME)'),
        },
      },
      response: { 200: launched, ...errors },
    },
  }, async (req) => {
    if (!config.exec) throw new ApiError('permission_denied', 'launching apps is disabled (OZWELL_COMPUTER_EXEC=false)');
    const b = req.body as { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
    return launchDetached(desktop.x.displayName, b.command, b.args, b.env, b.cwd);
  });

  app.post('/api/v1/open', {
    schema: {
      tags: ['apps'], summary: 'Open a file or URL with its default application',
      description: 'Runs xdg-open. Disabled when OZWELL_COMPUTER_EXEC=false.',
      body: { type: 'object', required: ['target'], properties: { target: prop('string', 'Path or URL; must not start with "-"', { minLength: 1 }) } },
      response: { 200: launched, ...errors },
    },
  }, async (req) => {
    if (!config.exec) throw new ApiError('permission_denied', 'opening targets is disabled (OZWELL_COMPUTER_EXEC=false)');
    const { target } = req.body as { target: string };
    if (target.startsWith('-')) throw new ApiError('invalid_request', 'target must not start with "-"');
    try {
      return await launchDetached(desktop.x.displayName, 'xdg-open', [target]);
    } catch (e) {
      if (e instanceof ApiError && e.reason === 'path_not_found') throw new ApiError('feature_unsupported', 'xdg-open is not installed', { feature: 'open' });
      throw e;
    }
  });

  // ---- events & presence
  app.get('/api/v1/events', {
    schema: {
      tags: ['events'], summary: 'Server-sent event stream',
      description: 'Starts with a hello event carrying the presence roster, a `stream_id` and the viewer `build` (changes when the server '
        + 'is updated to a new viewer), then window.*, clipboard.changed, display.*, '
        + 'presence, update, `job` and `job.removed` events as they happen, with a keepalive every 15 s. Each data line is JSON. With exec '
        + 'enabled, PUT /api/v1/events/{stream_id}/job makes this stream also carry one job\'s output.',
      response: { 200: media('An endless text/event-stream', ['text/event-stream'], { type: 'string' }), ...errors },
    },
  }, (_req, reply) => {
    const sse = openSse(reply, '/api/v1/events');
    if (sse.signal.aborted) return;
    const stream_id = randomBytes(16).toString('base64url');
    eventStreams.set(stream_id, sse);
    sse.send('hello', { roster: desktop.presence.roster(), stream_id, build: build() });
    m.sseClients.inc();
    const unsub = desktop.bus.subscribe((ev) => sse.send(ev.type, ev.data, ev.id));
    sse.signal.addEventListener('abort', () => { unsub(); eventStreams.delete(stream_id); m.sseClients.dec(); });
  });

  app.post('/api/v1/presence/join', {
    schema: {
      tags: ['presence'], summary: 'Join the desktop as a participant',
      description: 'Returns a participant_id for reporting a cursor and leaving.',
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: prop('string', 'Display name', { maxLength: 64 }),
          kind: prop('string', 'Who is joining (default human)', { enum: ['human', 'agent'] }),
          color: prop('string', 'Preferred colour (#rrggbb); one is assigned otherwise'),
        },
      },
      response: {
        200: record('Joined', { participant_id: prop('string', 'Your participant id'), color: prop('string', 'Your assigned colour'), roster }),
        ...errors,
      },
    },
  }, async (req) => {
    const p = desktop.presence.join((req.body as any) ?? {});
    return { participant_id: p.participant_id, color: p.color, roster: desktop.presence.roster() };
  });

  app.post('/api/v1/presence/cursor', {
    schema: {
      tags: ['presence'], summary: 'Report your cursor position', description: 'Shown to other participants. Fails with target_unavailable for an unknown participant.',
      body: {
        type: 'object', required: ['participant_id', 'x', 'y'],
        properties: {
          participant_id: prop('string', 'Id from /presence/join'),
          x: prop('number', 'X, 0..1 across the screen'), y: prop('number', 'Y, 0..1 down the screen'),
          visible: prop('boolean', 'Whether to show the cursor (default true)'),
        },
      },
      response: { 200: ok, ...errors },
    },
  }, async (req) => {
    const b = req.body as { participant_id: string; x: number; y: number; visible?: boolean };
    if (!desktop.presence.cursor(b.participant_id, b.x, b.y, b.visible ?? true)) throw new ApiError('target_unavailable', 'unknown participant');
    return { ok: true };
  });

  app.post('/api/v1/presence/leave', {
    schema: {
      tags: ['presence'], summary: 'Leave the desktop',
      body: { type: 'object', required: ['participant_id'], properties: { participant_id: prop('string', 'Id from /presence/join') } },
      response: { 200: record('Left', { ok: prop('boolean', 'Whether the participant existed') }), ...errors },
    },
  }, async (req) => {
    const { participant_id } = req.body as { participant_id: string };
    return { ok: desktop.presence.leave(participant_id) };
  });

  app.get('/api/v1/presence', {
    schema: { tags: ['presence'], summary: 'Who is on the desktop', response: { 200: record('Current participants', { roster }), ...errors } },
  }, async () => ({ roster: desktop.presence.roster() }));
}
