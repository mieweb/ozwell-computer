import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import type { AppContext } from '../server.js';
import { m } from '../metrics.js';

const idParams = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const epochQuery = { type: 'object', properties: { epoch: { type: 'integer', minimum: 0 } } };

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

export default async function windowRoutes(app: FastifyInstance, ctx: AppContext) {
  const { desktop, config } = ctx;
  const wm = () => desktop.ctl().windows;

  app.get('/api/v1/windows', { schema: { tags: ['windows'] } }, async () => ({ windows: await wm().list() }));

  app.get('/api/v1/windows/:id', { schema: { tags: ['windows'], params: idParams, querystring: epochQuery } }, async (req) => {
    const { id } = req.params as { id: string };
    const wid = await wm().resolve(id, (req.query as any).epoch);
    return wm().info(wid);
  });

  for (const action of ['activate', 'minimize', 'maximize', 'restore', 'close'] as const) {
    app.post(`/api/v1/windows/:id/${action}`, { schema: { tags: ['windows'], params: idParams, querystring: epochQuery } }, async (req) => {
      const { id } = req.params as { id: string };
      const w = wm();
      const wid = await w.resolve(id, (req.query as any).epoch);
      await w[action](wid);
      return { ok: true };
    });
  }

  app.put('/api/v1/windows/:id/bounds', {
    schema: {
      tags: ['windows'], params: idParams, querystring: epochQuery,
      body: {
        type: 'object', additionalProperties: false,
        properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } },
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
      tags: ['apps'],
      body: {
        type: 'object', required: ['command'], additionalProperties: false,
        properties: {
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          cwd: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    if (!config.exec) throw new ApiError('permission_denied', 'launching apps is disabled (OZWELL_DESKTOP_EXEC=false)');
    const b = req.body as { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
    return launchDetached(desktop.x.displayName, b.command, b.args, b.env, b.cwd);
  });

  app.post('/api/v1/open', {
    schema: { tags: ['apps'], body: { type: 'object', required: ['target'], properties: { target: { type: 'string', minLength: 1 } } } },
  }, async (req) => {
    if (!config.exec) throw new ApiError('permission_denied', 'opening targets is disabled (OZWELL_DESKTOP_EXEC=false)');
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
  app.get('/api/v1/events', { schema: { tags: ['events'], summary: 'Server-sent event stream' } }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (type: string, data: unknown, id?: number) =>
      res.write(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    write('hello', { roster: desktop.presence.roster() });
    m.sseClients.inc();
    const unsub = desktop.bus.subscribe((ev) => write(ev.type, ev.data, ev.id));
    const ka = setInterval(() => write('keepalive', { ts: Date.now() }), 15_000);
    req.raw.on('close', () => { clearInterval(ka); unsub(); m.sseClients.dec(); });
  });

  app.post('/api/v1/presence/join', {
    schema: {
      tags: ['presence'],
      body: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 64 }, kind: { type: 'string', enum: ['human', 'agent'] }, color: { type: 'string' } },
      },
    },
  }, async (req) => {
    const p = desktop.presence.join((req.body as any) ?? {});
    return { participant_id: p.participant_id, color: p.color, roster: desktop.presence.roster() };
  });

  app.post('/api/v1/presence/cursor', {
    schema: {
      tags: ['presence'],
      body: {
        type: 'object', required: ['participant_id', 'x', 'y'],
        properties: { participant_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, visible: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    const b = req.body as { participant_id: string; x: number; y: number; visible?: boolean };
    if (!desktop.presence.cursor(b.participant_id, b.x, b.y, b.visible ?? true)) throw new ApiError('target_unavailable', 'unknown participant');
    return { ok: true };
  });

  app.post('/api/v1/presence/leave', {
    schema: { tags: ['presence'], body: { type: 'object', required: ['participant_id'], properties: { participant_id: { type: 'string' } } } },
  }, async (req) => {
    const { participant_id } = req.body as { participant_id: string };
    return { ok: desktop.presence.leave(participant_id) };
  });

  app.get('/api/v1/presence', { schema: { tags: ['presence'] } }, async () => ({ roster: desktop.presence.roster() }));
}
