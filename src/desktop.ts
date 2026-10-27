import type { Logger } from 'pino';
import { XManager, type XSession } from './x11/connection.js';
import { InputController, BUTTONS, type ButtonName } from './x11/input.js';
import { WindowManager, parseWindowId, hexId, type Bounds } from './x11/windows.js';
import { Clipboard } from './x11/clipboard.js';
import { captureRect, compositeCursor, getCursorImage, type Rect } from './x11/capture.js';
import { listDisplays } from './x11/displays.js';
import { normalizeModifier, resolveKeysym, isModifierKeysym, type Modifier } from './x11/keymap.js';
import { ScreenshotRegistry, resolvePoint, fitSize, type Space, type ScreenshotEntry } from './coords.js';
import { encodeFrame, CONTENT_TYPES, type ImageFormat } from './image.js';
import { ApiError, unsupported } from './errors.js';
import { EventBus, Presence, type Principal } from './presence/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Controllers {
  s: XSession;
  input: InputController;
  windows: WindowManager;
  clipboard: Clipboard;
}

export interface ScreenshotOptions {
  format?: ImageFormat;
  quality?: number;
  max_dimension?: number;
  region?: Rect;
  window?: string;
  cursor?: boolean;
}

export interface ScreenshotResult {
  data: Buffer;
  contentType: string;
  format: ImageFormat;
  entry: ScreenshotEntry;
}

export interface PointerRequest {
  action: 'click' | 'move' | 'down' | 'up' | 'drag' | 'scroll';
  x?: number; y?: number; space?: Space; screenshot_id?: string; window?: string;
  button?: ButtonName; count?: number; modifiers?: string[];
  to?: { x: number; y: number }; path?: Array<{ x: number; y: number }>;
  dx?: number; dy?: number; unit?: 'line' | 'pixel'; duration_ms?: number;
  delivery?: 'foreground' | 'background';
}

export interface KeyboardRequest {
  action: 'type' | 'press' | 'hotkey' | 'down' | 'up';
  text?: string; mode?: 'keystrokes' | 'paste';
  key?: string; keys?: string[]; modifiers?: string[]; repeat?: number; delay_ms?: number;
  delivery?: 'foreground' | 'background';
}

export interface InputResult {
  delivery: 'foreground';
  pointer_moved: boolean;
  focus_changed: boolean;
  cursor: { x: number; y: number };
}

export class Desktop {
  readonly x: XManager;
  readonly bus = new EventBus();
  readonly presence: Presence;
  readonly registry = new ScreenshotRegistry();
  private ctlCache: Controllers | null = null;

  constructor(displayName: string, readonly log: Logger) {
    this.x = new XManager(displayName, log);
    this.presence = new Presence(this.bus);
    this.x.on('session', (s: XSession) => this.attach(s));
    this.x.on('down', () => {
      this.ctlCache?.windows.dispose();
      this.ctlCache?.clipboard.dispose();
      this.ctlCache = null;
      this.bus.publish('display.disconnected', {});
    });
  }

  async start() {
    await this.x.start();
  }

  private attach(s: XSession) {
    const ctl: Controllers = {
      s,
      input: new InputController(s),
      windows: new WindowManager(s),
      clipboard: new Clipboard(s),
    };
    ctl.windows.on('created', (d) => this.bus.publish('window.created', d));
    ctl.windows.on('destroyed', (d) => this.bus.publish('window.destroyed', d));
    ctl.windows.on('focus', (d) => this.bus.publish('window.focus', d));
    ctl.windows.on('bounds', (d) => this.bus.publish('window.bounds', d));
    ctl.windows.on('changed', (d) => this.bus.publish('window.changed', d));
    ctl.clipboard.on('changed', (d) => this.bus.publish('clipboard.changed', d));
    s.on('geometry', (g) => this.bus.publish('display.geometry', g));
    this.ctlCache = ctl;
    this.bus.publish('display.connected', { width: s.width, height: s.height });
  }

  ctl(): Controllers {
    const s = this.x.require();
    if (!this.ctlCache || this.ctlCache.s !== s) this.attach(s);
    return this.ctlCache!;
  }

  async stop() {
    try { await this.ctlCache?.input.releaseAll(); } catch { /* ignore */ }
    this.presence.dispose();
    this.x.stop();
  }

  // ---------------------------------------------------------------- screen

  async displays() {
    return listDisplays(this.ctl().s);
  }

  async screenshot(o: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const { s, windows } = this.ctl();
    const format = o.format ?? 'png';
    let region: Rect = o.region ?? { x: 0, y: 0, w: s.width, h: s.height };
    let window: { wid: number; bounds: Bounds } | undefined;
    if (o.window) {
      const wid = await windows.resolve(o.window);
      const b = await windows.bounds(wid);
      window = { wid, bounds: b };
      region = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    const epoch = s.geometryEpoch;
    let frame;
    try {
      frame = await captureRect(s, region);
    } catch (e) {
      if (e instanceof RangeError) throw new ApiError('invalid_request', e.message);
      throw e;
    }
    if (o.cursor) {
      const c = await getCursorImage(s).catch(() => null);
      if (c) compositeCursor(frame, c);
    }
    const fit = fitSize(frame.width, frame.height, o.max_dimension);
    const enc = await encodeFrame(frame, format, { quality: o.quality, width: fit.width, height: fit.height });
    const entry = this.registry.add({
      origin: { x: frame.x, y: frame.y },
      scale: fit.scale,
      imageSize: { width: enc.width, height: enc.height },
      nativeSize: { width: frame.width, height: frame.height },
      root: { width: s.width, height: s.height },
      geometryEpoch: epoch,
      window,
    });
    return { data: enc.data, contentType: CONTENT_TYPES[enc.format], format: enc.format, entry };
  }

  async cursor() {
    const { input, windows } = this.ctl();
    const p = await input.pointer();
    const wid = await windows.windowAt(p.x, p.y).catch(() => null);
    return { x: p.x, y: p.y, window: wid ? hexId(wid) : null };
  }

  // ----------------------------------------------------------------- input

  private async point(ctl: Controllers, p: { x?: number; y?: number; space?: Space; screenshot_id?: string; window?: string }) {
    if (p.x === undefined || p.y === undefined) return null;
    return resolvePoint(
      { x: p.x, y: p.y, space: p.space, screenshot_id: p.screenshot_id, window: p.window !== undefined ? parseWindowId(p.window) : undefined },
      {
        root: { width: ctl.s.width, height: ctl.s.height },
        geometryEpoch: ctl.s.geometryEpoch,
        registry: this.registry,
        windowBounds: (wid) => ctl.windows.bounds(wid),
      },
    );
  }

  private async glide(ctl: Controllers, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number) {
    const steps = Math.max(1, Math.min(120, Math.round(durationMs / 16)));
    for (let i = 1; i <= steps; i++) {
      await ctl.input.moveTo(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      if (durationMs) await sleep(durationMs / steps);
    }
  }

  private mods(list?: string[]): Modifier[] {
    try {
      return (list ?? []).map(normalizeModifier);
    } catch (e) {
      throw new ApiError('invalid_request', (e as Error).message);
    }
  }

  private async finish(ctl: Controllers, before: { active: number; x: number; y: number }, principal: Principal | null): Promise<InputResult> {
    await sleep(20);
    const p = await ctl.input.pointer();
    const active = await ctl.windows.activeId().catch(() => before.active);
    this.publishAgentCursor(principal, p.x, p.y, ctl);
    return {
      delivery: 'foreground',
      pointer_moved: p.x !== before.x || p.y !== before.y,
      focus_changed: active !== before.active,
      cursor: { x: p.x, y: p.y },
    };
  }

  publishAgentCursor(principal: Principal | null, x: number, y: number, ctl = this.ctlCache) {
    if (!principal || principal.kind !== 'agent' || !ctl) return;
    const key = principal.id?.startsWith('mcp:') ? principal.id : principal.id ? `principal:${principal.id}` : `principal-name:${principal.name ?? 'agent'}`;
    const part = this.presence.join({ name: principal.name ?? principal.id ?? 'agent', kind: 'agent', key });
    this.presence.cursor(part.participant_id, x / Math.max(1, ctl.s.width - 1), y / Math.max(1, ctl.s.height - 1), true);
  }

  async pointerAction(req: PointerRequest, principal: Principal | null = null): Promise<InputResult> {
    if (req.delivery === 'background') throw new ApiError('would_require_activation', 'X11 input via XTEST is always delivered to the foreground; use accessibility actions for background-safe interaction');
    const ctl = this.ctl();
    if (!ctl.input.available) throw unsupported('input', 'the XTEST extension is not available');
    const target = await this.point(ctl, req);
    const button = BUTTONS[req.button ?? 'left'];
    if (!button) throw new ApiError('invalid_request', `unknown button: ${req.button}`);
    const mods = this.mods(req.modifiers);
    return ctl.input.run(async () => {
      const start = await ctl.input.pointer();
      const before = { active: await ctl.windows.activeId().catch(() => 0), x: start.x, y: start.y };
      const moveTo = async (pt: { x: number; y: number } | null) => {
        if (!pt) return;
        if (req.duration_ms && req.action === 'move') await this.glide(ctl, await ctl.input.pointer(), pt, req.duration_ms);
        else await ctl.input.moveTo(pt.x, pt.y);
      };
      switch (req.action) {
        case 'move':
          if (!target) throw new ApiError('invalid_request', 'move requires x and y');
          await moveTo(target);
          break;
        case 'click':
          await moveTo(target);
          await ctl.input.modifiersDown(mods);
          try { await ctl.input.click(button, Math.max(1, Math.min(10, req.count ?? 1))); }
          finally { await ctl.input.modifiersUp(mods); }
          break;
        case 'down':
          await moveTo(target);
          await ctl.input.button(button, true);
          break;
        case 'up':
          await moveTo(target);
          await ctl.input.button(button, false);
          break;
        case 'drag': {
          const pts: Array<{ x: number; y: number }> = [];
          for (const p of req.path ?? []) pts.push((await this.point(ctl, { ...req, x: p.x, y: p.y }))!);
          if (req.to) pts.push((await this.point(ctl, { ...req, x: req.to.x, y: req.to.y }))!);
          if (pts.length === 0) throw new ApiError('invalid_request', 'drag requires "to" or "path"');
          const from = target ?? (await ctl.input.pointer());
          await ctl.input.moveTo(from.x, from.y);
          await ctl.input.modifiersDown(mods);
          await ctl.input.button(button, true);
          try {
            const per = (req.duration_ms ?? 300) / pts.length;
            let cur = from;
            for (const p of pts) { await this.glide(ctl, cur, p, per); cur = p; }
          } finally {
            await ctl.input.button(button, false);
            await ctl.input.modifiersUp(mods);
          }
          break;
        }
        case 'scroll': {
          await moveTo(target);
          let dx = req.dx ?? 0, dy = req.dy ?? 0;
          if (req.unit === 'pixel') {
            const conv = (v: number) => (v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 40)));
            dx = conv(dx); dy = conv(dy);
          }
          if (Math.abs(dx) + Math.abs(dy) > 200) throw new ApiError('limit_exceeded', 'scroll amount too large');
          await ctl.input.modifiersDown(mods);
          try { await ctl.input.scroll(dx, dy); } finally { await ctl.input.modifiersUp(mods); }
          break;
        }
        default:
          throw new ApiError('invalid_request', `unknown pointer action: ${(req as any).action}`);
      }
      return this.finish(ctl, before, principal);
    });
  }

  private keysym(key: string): number {
    try { return resolveKeysym(key); } catch (e) { throw new ApiError('invalid_request', (e as Error).message); }
  }

  async keyboardAction(req: KeyboardRequest, principal: Principal | null = null): Promise<InputResult> {
    if (req.delivery === 'background') throw new ApiError('would_require_activation', 'X11 keyboard input is always delivered to the focused window');
    const ctl = this.ctl();
    if (!ctl.input.available) throw unsupported('input', 'the XTEST extension is not available');
    const mods = this.mods(req.modifiers);
    const repeat = Math.max(1, Math.min(100, req.repeat ?? 1));
    return ctl.input.run(async () => {
      const start = await ctl.input.pointer();
      const before = { active: await ctl.windows.activeId().catch(() => 0), x: start.x, y: start.y };
      switch (req.action) {
        case 'type': {
          if (typeof req.text !== 'string') throw new ApiError('invalid_request', 'type requires text');
          if (req.text.length > 100_000) throw new ApiError('limit_exceeded', 'text too long');
          if (req.mode === 'paste') await this.paste(ctl, req.text);
          else await ctl.input.typeText(req.text, req.delay_ms ?? 0);
          break;
        }
        case 'press': {
          if (!req.key) throw new ApiError('invalid_request', 'press requires key');
          const ks = this.keysym(req.key);
          for (let i = 0; i < repeat; i++) {
            await ctl.input.tap(ks, { modifiers: mods });
            if (req.delay_ms) await sleep(req.delay_ms);
          }
          break;
        }
        case 'hotkey': {
          const keys = req.keys ?? (req.key ? [req.key] : []);
          if (keys.length === 0) throw new ApiError('invalid_request', 'hotkey requires keys');
          const syms = keys.map((k) => this.keysym(k));
          for (let i = 0; i < repeat; i++) {
            const held: number[] = [];
            try {
              for (const m of mods) { const k = this.keysym(m); await ctl.input.keyRaw(k, true); held.push(k); }
              for (const ks of syms.slice(0, -1)) { await ctl.input.keyRaw(ks, true); held.push(ks); }
              const last = syms[syms.length - 1];
              if (isModifierKeysym(last)) { await ctl.input.keyRaw(last, true); await ctl.input.keyRaw(last, false); }
              else { await ctl.input.keyRaw(last, true); await ctl.input.keyRaw(last, false); }
            } finally {
              for (const ks of held.reverse()) await ctl.input.keyRaw(ks, false);
            }
            if (req.delay_ms) await sleep(req.delay_ms);
          }
          break;
        }
        case 'down':
        case 'up': {
          if (!req.key) throw new ApiError('invalid_request', `${req.action} requires key`);
          await ctl.input.keyRaw(this.keysym(req.key), req.action === 'down');
          break;
        }
        default:
          throw new ApiError('invalid_request', `unknown keyboard action: ${(req as any).action}`);
      }
      return this.finish(ctl, before, principal);
    });
  }

  private async paste(ctl: Controllers, text: string) {
    const prev = await ctl.clipboard.read().catch(() => null);
    await ctl.clipboard.write({ text });
    await sleep(30);
    await ctl.input.tap(this.keysym('v'), { modifiers: ['ctrl'] });
    await sleep(200);
    if (prev && (prev.text !== undefined || prev.image_png_base64)) {
      await ctl.clipboard.write({ text: prev.text, image_png_base64: prev.image_png_base64 });
    }
  }
}
