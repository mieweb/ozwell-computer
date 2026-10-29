import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { AppContext } from '../server.js';
import { parsePrincipal } from '../presence/index.js';
import type { ImageFormat } from '../image.js';
import { getTheme, setTheme, type ColorScheme } from '../theme.js';
import { bounds, errors, feature, inputResult, media, obj, point, prop, record, updateStatus, windowRef } from './schemas.js';

const themeState = record('The desktop color scheme', {
  scheme: prop('string', 'GTK and window theme in use: Greybird (light) or Greybird-dark (dark)', { enum: ['light', 'dark'] }),
  set: prop('boolean', 'Whether a scheme has been chosen; until then the desktop is light and the first viewer may pick one'),
});

const capabilities = record('What this server can do right now', {
  version: prop('string', 'Server version'),
  auth: prop('string', 'Whether requests need a token', { enum: ['token', 'disabled'] }),
  display: obj('The X display', {
    name: prop('string', 'X display name, e.g. :99'),
    connected: prop('boolean', 'Whether the X connection is up'),
    width: prop('integer', 'Root window width (when connected)'),
    height: prop('integer', 'Root window height (when connected)'),
    depth: prop('integer', 'Bits per pixel (when connected)'),
    geometry_epoch: prop('integer', 'Increments when the screen size changes; screenshot ids from earlier epochs are stale'),
    error: prop(['string', 'null'], 'Last connection error (when disconnected)'),
  }, { required: ['name', 'connected'] }),
  extensions: prop('array', 'X extensions available on the display', { items: { type: 'string' } }),
  features: record('Per-feature availability', {
    screenshot: feature, input: feature, damage: feature, clipboard: feature, clipboard_events: feature, windows: feature,
    a11y: feature, exec: feature, pty: feature,
    vnc: record('Built-in VNC (always available)', {
      available: prop('boolean', 'Always true'),
      backend: prop('string', 'builtin, or external:[host:]port when proxying another VNC server'),
      view_only: prop('boolean', 'Whether VNC clients may only watch'),
    }),
    mcp: feature, update: feature, background_delivery: feature,
  }),
});

const geometryHeader = (description: string) => prop('string', description);
const screenshotImage = media('The encoded image', ['image/png', 'image/jpeg', 'image/webp']);
const screenshotMeta = {
  screenshot_id: prop('string', 'Id to pass as screenshot_id with coordinates from this image'),
  format: prop('string', 'Image encoding', { enum: ['png', 'jpeg', 'webp'] }),
  width: prop('integer', 'Image width'),
  height: prop('integer', 'Image height'),
  native_width: prop('integer', 'Captured region width in screen pixels'),
  native_height: prop('integer', 'Captured region height in screen pixels'),
  scale: prop('number', 'Screen pixels per image pixel (>= 1 when downscaled)'),
  origin: { ...point, description: 'Top-left of the captured region in screen pixels' },
  window: prop(['string', 'null'], 'Captured window (hex id), or null for the screen'),
  image_base64: prop('string', 'The encoded image, base64'),
};
const screenshotResponse = {
  ...screenshotImage,
  description: 'The encoded image, or JSON with image_base64 when Accept includes application/json',
  headers: {
    'x-screenshot-id': geometryHeader('Id to pass as screenshot_id with coordinates from this image'),
    'x-image-size': geometryHeader('Image size, WIDTHxHEIGHT'),
    'x-native-size': geometryHeader('Captured region size in screen pixels, WIDTHxHEIGHT'),
    'x-scale': geometryHeader('Screen pixels per image pixel'),
    'x-origin': geometryHeader('Top-left of the captured region in screen pixels, X,Y'),
  },
  content: {
    ...screenshotImage.content,
    'application/json': {
      schema: obj('Screenshot with geometry', {
        ...screenshotMeta,
        text: prop('string', 'Text recognized in the image (only with ocr)'),
      }, { required: Object.keys(screenshotMeta) }),
    },
  },
};

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

  app.get('/api/v1/capabilities', {
    schema: {
      tags: ['system'], summary: 'Server capabilities',
      description: 'Version, auth mode, display state and which features are usable right now (with the reason when not).',
      response: { 200: capabilities, ...errors },
    },
  }, async () => {
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
  app.get('/api/v1/update', {
    schema: {
      tags: ['system'], summary: 'Installed vs latest released version, and upgrade progress',
      description: 'Fails with feature_unsupported when update checks are not running.',
      response: { 200: updateStatus, ...errors },
    },
  }, async () => updater().status());
  app.post('/api/v1/update/check', {
    schema: {
      tags: ['system'], summary: 'Check for a new release now',
      description: 'Fetches the release index; a failed fetch is reported in the status error field rather than as an HTTP error.',
      response: { 200: updateStatus, ...errors },
    },
  }, async () => updater().check());
  app.post('/api/v1/update/apply', {
    schema: {
      tags: ['system'], summary: 'Upgrade the ozwell-computer package (the server restarts)',
      description: 'Asks the root upgrade unit to install the latest package. Poll GET /api/v1/update for progress.',
      response: { 202: { ...updateStatus, description: 'Upgrade requested' }, ...errors },
    },
  }, async (_req, reply) => reply.code(202).send(await updater().apply()));

  app.get('/api/v1/displays', {
    schema: {
      tags: ['system'], summary: 'List monitors',
      description: 'RandR outputs with their placement on the root window; a single "root" display when RandR is unavailable.',
      response: {
        200: record('Connected displays', {
          displays: prop('array', 'Displays, primary first', {
            items: record('A display', {
              id: prop('string', 'RandR output id, or "root"'),
              name: prop('string', 'Output name (e.g. HDMI-1), or "root"'),
              primary: prop('boolean', 'Whether this is the primary display'),
              bounds,
              scale: prop('number', 'Device pixel ratio (always 1)'),
            }),
          }),
        }),
        ...errors,
      },
    },
  }, async () => ({ displays: await desktop.displays() }));

  // ---- desktop theme
  app.get('/api/v1/desktop/theme', {
    schema: {
      tags: ['system'], summary: 'Desktop color scheme; set is false until a client has chosen one',
      response: { 200: themeState, ...errors },
    },
  }, async () => getTheme());
  app.put('/api/v1/desktop/theme', {
    schema: {
      tags: ['system'],
      summary: 'Switch the desktop GTK and window theme to light or dark',
      description: 'With if_unset, only applies when no scheme has been chosen yet (the viewer sends the browser\'s prefers-color-scheme this way on first connection). Fails with feature_unsupported when xfconf-query is not installed.',
      body: {
        type: 'object', required: ['scheme'], additionalProperties: false,
        properties: {
          scheme: prop('string', 'Color scheme to apply', { enum: ['light', 'dark'] }),
          if_unset: prop('boolean', 'Only apply when no scheme has been chosen yet; otherwise return the current one'),
        },
      },
      response: { 200: { ...themeState, description: 'The scheme now in effect' }, ...errors },
    },
  }, async (req) => {
    const b = req.body as { scheme: ColorScheme; if_unset?: boolean };
    const state = await setTheme(b.scheme, b.if_unset);
    desktop.bus.publish('desktop.theme', state);
    return state;
  });

  app.get<{ Querystring: Record<string, string> }>('/api/v1/screenshot', {
    schema: {
      tags: ['screen'],
      summary: 'Capture the screen',
      description: 'Returns the encoded image with geometry in X-* headers, or JSON with image_base64 when Accept includes application/json or ocr is set. ' +
        'Pass the returned screenshot_id with pointer coordinates taken from this image (space=screenshot).',
      querystring: {
        type: 'object',
        properties: {
          format: prop('string', 'Image encoding (default png)', { enum: ['png', 'jpeg', 'webp'] }),
          quality: prop('integer', 'Lossy quality for jpeg/webp', { minimum: 1, maximum: 100 }),
          max_dimension: prop('integer', 'Downscale so neither side exceeds this many pixels', { minimum: 16, maximum: 16384 }),
          region: prop('string', 'Capture only this rectangle: x,y,width,height in screen pixels', { pattern: '^\\d+,\\d+,\\d+,\\d+$' }),
          window: prop('string', `Capture only this window. ${windowRef}`),
          cursor: prop('string', 'Draw the mouse cursor into the image when 1 or true'),
          ocr: prop('string', 'true or 1: extract text from the captured region/window with tesseract and return JSON with a text field'),
        },
      },
      response: { 200: screenshotResponse, ...errors },
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

  app.get('/api/v1/cursor', {
    schema: {
      tags: ['screen'], summary: 'Pointer position',
      response: {
        200: record('Where the pointer is', {
          x: prop('integer', 'X in screen pixels'),
          y: prop('integer', 'Y in screen pixels'),
          window: prop(['string', 'null'], 'Window under the pointer (hex id), if any'),
        }),
        ...errors,
      },
    },
  }, async () => desktop.cursor());

  const coord = (axis: string) => prop('number', `${axis} coordinate in the chosen space`);
  const pointerSchema = {
    type: 'object',
    required: ['action'],
    properties: {
      action: prop('string', 'click; move; down/up (press or release a button); drag (to "to" or along "path"); scroll (by dx/dy)', { enum: ['click', 'move', 'down', 'up', 'drag', 'scroll'] }),
      x: coord('X'), y: coord('Y'),
      space: prop('string', 'Coordinate space of x/y: screen pixels, window-relative pixels, pixels of a screenshot, or 0..1 normalized (of window or screen). Default screenshot when screenshot_id is given, else screen', { enum: ['screen', 'window', 'screenshot', 'normalized'] }),
      screenshot_id: prop('string', 'Interpret coordinates in the pixel space of this screenshot (fails with stale_geometry if the screen changed)'),
      window: prop('string', `Reference window for space=window|normalized. ${windowRef}`),
      button: prop('string', 'Mouse button (default left)', { enum: ['left', 'right', 'middle', 'back', 'forward'] }),
      count: prop('integer', 'Number of clicks (2 = double-click)', { minimum: 1, maximum: 10 }),
      modifiers: prop('array', 'Keys held during the action: ctrl, shift, alt, super', { items: { type: 'string' } }),
      to: { ...point, description: 'Drag destination, in the same space as x/y' },
      path: prop('array', 'Drag waypoints, in the same space as x/y', { maxItems: 1000, items: point }),
      dx: prop('number', 'Horizontal scroll; positive scrolls right'),
      dy: prop('number', 'Vertical scroll; positive scrolls down'),
      unit: prop('string', 'Scroll unit: wheel clicks (line, default) or pixels (~40 px per click)', { enum: ['line', 'pixel'] }),
      duration_ms: prop('integer', 'Glide time for move and drag', { minimum: 0, maximum: 10000 }),
      delivery: prop('string', 'background is refused with would_require_activation: XTEST input always reaches the foreground', { enum: ['foreground', 'background'] }),
    },
    additionalProperties: false,
  };
  const keyboardSchema = {
    type: 'object',
    required: ['action'],
    properties: {
      action: prop('string', 'type text; press a key; hotkey (chord of keys); down/up (hold or release a key)', { enum: ['type', 'press', 'hotkey', 'down', 'up'] }),
      text: prop('string', 'Text to type (action=type)', { maxLength: 100000 }),
      mode: prop('string', 'keystrokes (default) or paste through the clipboard (robust for long or non-ASCII text)', { enum: ['keystrokes', 'paste'] }),
      key: prop('string', 'Key name for press/down/up, e.g. Enter, Escape, Tab, ArrowDown, F5, a'),
      keys: prop('array', 'Keys pressed together for hotkey, e.g. ["ctrl","shift","t"]', { items: { type: 'string' }, maxItems: 10 }),
      modifiers: prop('array', 'Modifiers held during press/hotkey: ctrl, shift, alt, super', { items: { type: 'string' } }),
      repeat: prop('integer', 'Repeat press/hotkey this many times', { minimum: 1, maximum: 100 }),
      delay_ms: prop('integer', 'Delay between keystrokes or repeats', { minimum: 0, maximum: 5000 }),
      delivery: prop('string', 'background is refused with would_require_activation: keyboard input goes to the focused window', { enum: ['foreground', 'background'] }),
    },
    additionalProperties: false,
  };

  app.post('/api/v1/input/pointer', {
    schema: {
      tags: ['input'], summary: 'Mouse action', description: 'Click, move, press, release, drag or scroll via XTEST.',
      body: pointerSchema, response: { 200: inputResult, ...errors },
    },
  }, async (req) => {
    return desktop.pointerAction(req.body as any, principalOf(req));
  });
  app.post('/api/v1/input/keyboard', {
    schema: {
      tags: ['input'], summary: 'Keyboard action', description: 'Type text or press keys in the focused window via XTEST.',
      body: keyboardSchema, response: { 200: inputResult, ...errors },
    },
  }, async (req) =>
    desktop.keyboardAction(req.body as any, principalOf(req)));

  // ---- clipboard
  app.get('/api/v1/clipboard', {
    schema: {
      tags: ['clipboard'], summary: 'Read the clipboard',
      response: {
        200: obj('Clipboard content; text and image are present only when offered by the owner', {
          generation: prop('integer', 'Increments whenever the clipboard owner changes'),
          text: prop('string', 'Text content'),
          image_png_base64: prop('string', 'PNG image, base64-encoded'),
        }, { required: ['generation'] }),
        ...errors,
      },
    },
  }, async () => desktop.ctl().clipboard.read());
  app.put('/api/v1/clipboard', {
    schema: {
      tags: ['clipboard'], summary: 'Set the clipboard', description: 'Provide text, an image, or both.',
      body: {
        type: 'object',
        properties: { text: prop('string', 'Text content'), image_png_base64: prop('string', 'PNG image, base64-encoded') },
        additionalProperties: false,
      },
      response: {
        200: record('Clipboard set', { ok: prop('boolean', 'Always true'), generation: prop('integer', 'Clipboard generation after the write') }),
        ...errors,
      },
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
