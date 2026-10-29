import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { AppContext } from '../server.js';
import { parsePrincipal } from '../presence/index.js';
import type { ImageFormat } from '../image.js';

export function principalOf(req: FastifyRequest) {
  return parsePrincipal(req.headers['x-principal']);
}

export default async function coreRoutes(app: FastifyInstance, ctx: AppContext) {
  const { desktop, config } = ctx;

  // Polled by healthchecks every few seconds: never logged.
  app.get('/health', { schema: { hide: true }, logLevel: 'silent' }, async (_req, reply) => {
    if (desktop.x.session) return reply.code(204).send();
    return reply.code(503).send(new ApiError('target_unavailable', 'X display not connected').toBody());
  });

  app.get('/api/v1/capabilities', { schema: { tags: ['system'], summary: 'Server capabilities' } }, async () => {
    const s = desktop.x.session;
    const feat = (ok: boolean, limitation: string) => (ok ? { available: true } : { available: false, limitation });
    return {
      version: ctx.version,
      auth: config.authDisabled ? 'disabled' : 'token',
      display: s
        ? { name: s.displayName, connected: true, width: s.width, height: s.height, depth: s.pixel.depth, geometry_epoch: s.geometryEpoch }
        : { name: config.display, connected: false, error: desktop.x.lastError },
      extensions: s?.extensionNames() ?? [],
      features: {
        screenshot: feat(!!s, 'X display not connected'),
        input: feat(!!s?.ext.xtest, s ? 'XTEST extension missing' : 'X display not connected'),
        damage: feat(!!s?.ext.damage, 'DAMAGE missing; VNC falls back to polling'),
        clipboard: feat(!!s, 'X display not connected'),
        clipboard_events: feat(!!s?.ext.fixes, 'XFIXES missing; clipboard generation only tracks our own writes'),
        windows: feat(!!s, 'X display not connected'),
        a11y: ctx.a11y ? await ctx.a11y.capability() : feat(false, 'accessibility disabled'),
        exec: feat(config.exec, 'disabled by OZWELL_COMPUTER_EXEC=false'),
        pty: feat(config.exec && ctx.ptyAvailable, config.exec ? 'node-pty not installed' : 'disabled by OZWELL_COMPUTER_EXEC=false'),
        vnc: { available: true, backend: config.vncBackend, view_only: config.viewOnly },
        mcp: { available: true },
        update: ctx.updater ? await ctx.updater.status().then((u) => (u.supported ? { available: true } : { available: false, limitation: u.limitation })) : feat(false, 'update checks are not running'),
        background_delivery: feat(false, 'XTEST injects into the global input stream; only accessibility actions are background-safe'),
      },
    };
  });

  // ---- updates
  const updater = () => {
    if (!ctx.updater) throw new ApiError('feature_unsupported', 'update checks are not running', { feature: 'update' });
    return ctx.updater;
  };
  app.get('/api/v1/update', { schema: { tags: ['system'], summary: 'Installed vs latest released version, and upgrade progress' } },
    async () => updater().status());
  app.post('/api/v1/update/check', { schema: { tags: ['system'], summary: 'Check for a new release now' } },
    async () => updater().check());
  app.post('/api/v1/update/apply', { schema: { tags: ['system'], summary: 'Upgrade the ozwell-computer package (the server restarts)' } },
    async (_req, reply) => reply.code(202).send(await updater().apply()));

  app.get('/api/v1/displays', { schema: { tags: ['system'] } }, async () => ({ displays: await desktop.displays() }));

  app.get<{ Querystring: Record<string, string> }>('/api/v1/screenshot', {
    schema: {
      tags: ['screen'],
      summary: 'Capture the screen',
      description: 'Returns the image bytes, or JSON with image_base64 when Accept includes application/json or ocr is set.',
      querystring: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
          quality: { type: 'integer', minimum: 1, maximum: 100 },
          max_dimension: { type: 'integer', minimum: 16, maximum: 16384 },
          region: { type: 'string', pattern: '^\\d+,\\d+,\\d+,\\d+$' },
          window: { type: 'string' },
          cursor: { type: 'string' },
          ocr: { type: 'string', description: 'true or 1: extract text from the captured region/window with tesseract and return JSON with a text field' },
        },
      },
    },
  }, async (req, reply) => {
    const q = req.query as any;
    let region;
    if (q.region) {
      const [x, y, w, h] = String(q.region).split(',').map(Number);
      region = { x, y, w, h };
    }
    const flag = (v: unknown) => v === '1' || v === 'true';
    const r = await desktop.screenshot({
      format: q.format as ImageFormat, quality: q.quality, max_dimension: q.max_dimension, region, window: q.window,
      cursor: flag(q.cursor), ocr: flag(q.ocr),
    });
    const e = r.entry;
    const meta = {
      screenshot_id: e.id, format: r.format, width: e.imageSize.width, height: e.imageSize.height,
      native_width: e.nativeSize.width, native_height: e.nativeSize.height, scale: e.scale, origin: e.origin,
      window: e.window ? '0x' + e.window.wid.toString(16) : null,
    };
    reply.header('cache-control', 'no-store');
    if (r.text !== undefined || (req.headers.accept ?? '').includes('application/json')) {
      return { ...meta, image_base64: r.data.toString('base64'), ...(r.text !== undefined ? { text: r.text } : {}) };
    }
    return reply
      .header('content-type', r.contentType)
      .header('x-screenshot-id', e.id)
      .header('x-image-size', `${e.imageSize.width}x${e.imageSize.height}`)
      .header('x-native-size', `${e.nativeSize.width}x${e.nativeSize.height}`)
      .header('x-scale', String(e.scale))
      .header('x-origin', `${e.origin.x},${e.origin.y}`)
      .send(r.data);
  });

  app.get('/api/v1/cursor', { schema: { tags: ['screen'] } }, async () => desktop.cursor());

  const pointerSchema = {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['click', 'move', 'down', 'up', 'drag', 'scroll'] },
      x: { type: 'number' }, y: { type: 'number' },
      space: { type: 'string', enum: ['screen', 'window', 'screenshot', 'normalized'] },
      screenshot_id: { type: 'string' }, window: { type: 'string' },
      button: { type: 'string', enum: ['left', 'right', 'middle', 'back', 'forward'] },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      modifiers: { type: 'array', items: { type: 'string' } },
      to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      path: { type: 'array', maxItems: 1000, items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
      dx: { type: 'number' }, dy: { type: 'number' },
      unit: { type: 'string', enum: ['line', 'pixel'] },
      duration_ms: { type: 'integer', minimum: 0, maximum: 10000 },
      delivery: { type: 'string', enum: ['foreground', 'background'] },
    },
    additionalProperties: false,
  };
  const keyboardSchema = {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['type', 'press', 'hotkey', 'down', 'up'] },
      text: { type: 'string', maxLength: 100000 },
      mode: { type: 'string', enum: ['keystrokes', 'paste'] },
      key: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      modifiers: { type: 'array', items: { type: 'string' } },
      repeat: { type: 'integer', minimum: 1, maximum: 100 },
      delay_ms: { type: 'integer', minimum: 0, maximum: 5000 },
      delivery: { type: 'string', enum: ['foreground', 'background'] },
    },
    additionalProperties: false,
  };

  app.post('/api/v1/input/pointer', { schema: { tags: ['input'], body: pointerSchema } }, async (req) => {
    return desktop.pointerAction(req.body as any, principalOf(req));
  });
  app.post('/api/v1/input/keyboard', { schema: { tags: ['input'], body: keyboardSchema } }, async (req) =>
    desktop.keyboardAction(req.body as any, principalOf(req)));

  // ---- clipboard
  app.get('/api/v1/clipboard', { schema: { tags: ['clipboard'] } }, async () => desktop.ctl().clipboard.read());
  app.put('/api/v1/clipboard', {
    schema: {
      tags: ['clipboard'],
      body: { type: 'object', properties: { text: { type: 'string' }, image_png_base64: { type: 'string' } }, additionalProperties: false },
    },
  }, async (req) => {
    const b = req.body as { text?: string; image_png_base64?: string };
    if (b.text === undefined && !b.image_png_base64) throw new ApiError('invalid_request', 'provide text or image_png_base64');
    const generation = await desktop.ctl().clipboard.write(b);
    return { ok: true, generation };
  });

}

export function sendError(reply: FastifyReply, e: ApiError) {
  if (e.reason === 'unauthenticated') reply.header('www-authenticate', 'Bearer');
  return reply.code(e.status).send(e.toBody());
}
