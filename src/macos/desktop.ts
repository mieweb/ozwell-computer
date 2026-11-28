import sharp from 'sharp';
import type { Logger } from 'pino';
import type { DesktopBackend, DesktopStatus, WindowController, ClipboardController } from '../backend.js';
import type { ScreenshotOptions, ScreenshotResult, PointerRequest, KeyboardRequest, InputResult } from '../desktop.js';
import type { Bounds, WindowInfo } from '../x11/windows.js';
import type { ClipboardContent } from '../x11/clipboard.js';
import { ScreenshotRegistry, fitSize, resolvePoint } from '../coords.js';
import { CONTENT_TYPES } from '../image.js';
import { ApiError, unsupported } from '../errors.js';
import { EventBus, Presence, type Principal } from '../presence/index.js';
import { CuaConnectionError, createCuaClient, type CuaClient, type WindowInfo as CuaWindowInfo } from './driver.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hexId = (wid: number) => `0x${wid.toString(16)}`;

/** CGWindowID is a UInt32 even though Cua uses bigint for cross-platform IDs. */
export function macWindowId(id: string | number | bigint): number {
  const n = typeof id === 'string'
    ? /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(id) ? Number(id) : NaN
    : Number(id);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffff_ffff)
    throw new ApiError('invalid_request', `invalid macOS window id: ${String(id)}`);
  return n;
}

/** Native Mac pilot. API screen coordinates are logical points on the primary display. */
export class MacDesktop implements DesktopBackend {
  readonly kind = 'macos' as const;
  readonly displayName = 'macos:primary';
  readonly bus = new EventBus();
  readonly presence = new Presence(this.bus);
  readonly registry = new ScreenshotRegistry();
  private readonly driver: CuaClient;
  private connected = false;
  private lastError: string | null = 'Cua Driver has not connected';
  private permission = { accessibility: false, screenRecording: false };
  private geometry = { width: 0, height: 0, pixelWidth: 0, pixelHeight: 0 };
  private geometryEpoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private clipboardGeneration = 0;
  private windowIdentity = new Map<number, { pid?: number; epoch: number; present: boolean }>();
  private readonly windows: WindowController;
  private readonly clipboard: ClipboardController;

  constructor(readonly log: Logger, driver?: CuaClient) {
    this.driver = driver ?? createCuaClient();
    const noWindowMutation = async () => { throw unsupported('windows', 'native window mutations are not implemented in the macOS pilot'); };
    this.windows = {
      list: () => this.windowList(),
      resolve: (id, epoch) => this.resolveWindow(id, epoch),
      info: async (wid) => this.windowInfo(await this.nativeWindow(wid)),
      bounds: async (wid) => ({ ...(await this.nativeWindow(wid)).bounds }),
      setBounds: noWindowMutation, activate: noWindowMutation, minimize: noWindowMutation,
      maximize: noWindowMutation, restore: noWindowMutation, close: noWindowMutation,
    };
    this.clipboard = {
      read: async () => {
        const content = await this.nativeCall((client) => client.clipboardRead());
        return { ...content, generation: this.clipboardGeneration };
      },
      write: (content) => this.writeClipboard(content),
    };
  }

  async start() {
    try {
      await this.driver.start();
      this.connected = true;
      this.lastError = null;
      await this.refresh();
      this.bus.publish('display.connected', { width: this.geometry.width, height: this.geometry.height });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log.warn({ err: this.lastError }, 'native desktop unavailable; HTTP diagnostics remain available');
    }
  }

  async stop() {
    await this.queue.catch(() => undefined);
    this.presence.dispose();
    await this.driver.stop();
    this.connected = false;
  }

  /** Share one SDK instance and one input queue with the AX adapter. */
  async nativeCall<T>(operation: (client: CuaClient) => Promise<T>): Promise<T> {
    try {
      // Initialization can recover after the user installs/starts the signed
      // helper. Never retry the operation itself: its side effects may be unknown.
      if (!this.connected) await this.driver.start();
      const result = await operation(this.driver);
      this.connected = true;
      this.lastError = null;
      return result;
    } catch (error) {
      if (error instanceof CuaConnectionError) {
        this.connected = false;
        this.lastError = error.message;
        this.permission = { accessibility: false, screenRecording: false };
        this.bus.publish('display.disconnected', { error: this.lastError });
      } else if (error instanceof ApiError && error.reason === 'permission_denied') {
        this.lastError = error.message;
        // Revocation must be reflected in subsequent capability responses.
        this.permission = await this.driver.permissions().catch(() => ({ accessibility: false, screenRecording: false }));
      }
      throw error;
    }
  }

  runInput<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async accessibilityAvailable() {
    this.permission = await this.nativeCall((client) => client.permissions());
    return this.permission.accessibility;
  }

  private updateGeometry(width: number, height: number, pixelWidth: number, pixelHeight: number) {
    if (![width, height, pixelWidth, pixelHeight].every((n) => Number.isFinite(n) && n > 0))
      throw unsupported('screenshot', 'Cua Driver did not return valid primary-display geometry');
    if (this.geometry.width !== width || this.geometry.height !== height || this.geometry.pixelWidth !== pixelWidth || this.geometry.pixelHeight !== pixelHeight) {
      this.geometry = { width, height, pixelWidth, pixelHeight };
      this.geometryEpoch++;
      this.bus.publish('display.geometry', { width, height, geometry_epoch: this.geometryEpoch });
    }
  }

  private async refresh() {
    this.permission = await this.nativeCall((client) => client.permissions());
    const screen = await this.nativeCall((client) => client.screen());
    this.updateGeometry(screen.width, screen.height, screen.pixelWidth, screen.pixelHeight);
  }

  private requirePermission(feature: 'input' | 'screenshot') {
    const allowed = feature === 'input' ? this.permission.accessibility : this.permission.screenRecording;
    if (allowed) return;
    const permission = feature === 'input' ? 'Accessibility' : 'Screen Recording';
    this.lastError = `Grant ${permission} permission to Cua Driver in macOS System Settings`;
    throw new ApiError('permission_denied', this.lastError, { feature });
  }

  status(): DesktopStatus {
    const ready = this.connected && this.geometry.width > 0;
    const feat = (available: boolean, limitation: string) => ({ available, ...(available ? {} : { limitation }) });
    const unavailable = this.lastError ?? 'Cua Driver is not connected';
    return {
      display: {
        name: this.displayName, connected: ready,
        ...(ready ? { width: this.geometry.width, height: this.geometry.height, depth: 32, geometry_epoch: this.geometryEpoch } : {}),
        error: this.lastError,
      },
      extensions: [],
      features: {
        screenshot: { ...feat(ready && this.permission.screenRecording, ready ? 'Grant Screen Recording to Cua Driver in macOS System Settings' : unavailable), ...(ready && this.permission.screenRecording ? { limitation: 'Primary display only; screen coordinates are logical points; cursor capture is unsupported' } : {}) },
        input: { ...feat(ready && this.permission.accessibility, ready ? 'Grant Accessibility to Cua Driver in macOS System Settings' : unavailable), ...(ready && this.permission.accessibility ? { limitation: 'Foreground clicks, move, line scroll, type, press, and hotkey; held keys/buttons and drag unsupported' } : {}) },
        damage: feat(false, 'native damage events are not implemented'),
        clipboard: { ...feat(ready, unavailable), ...(ready ? { limitation: 'Plain text only; generation tracks Ozwell writes' } : {}) },
        clipboard_events: feat(false, 'external clipboard changes are not observed'),
        windows: { ...feat(ready, unavailable), ...(ready ? { limitation: 'Window discovery and bounds only; focus/maximized state and window mutations are unsupported' } : {}) },
        background_delivery: feat(false, 'pointer and keyboard input target the foreground; AX press is separately supported without foreground fallback'),
        vnc: feat(false, 'native live streaming is not implemented; use screenshot preview'),
      },
    };
  }

  ctl() { return { windows: this.windows, clipboard: this.clipboard }; }

  async displays() {
    await this.refresh();
    return [{ id: 'primary', name: 'Primary macOS display', primary: true,
      bounds: { x: 0, y: 0, width: this.geometry.width, height: this.geometry.height },
      scale: this.geometry.pixelWidth / this.geometry.width }];
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    if (options.cursor) throw unsupported('screenshot', 'cursor capture is not implemented in the macOS pilot');
    if (options.ocr) throw unsupported('screenshot', 'OCR is not implemented in the macOS pilot');
    this.permission = await this.nativeCall((client) => client.permissions());
    this.requirePermission('screenshot');
    let window: { wid: number; bounds: Bounds } | undefined;
    if (options.window) {
      const wid = await this.windows.resolve(options.window);
      window = { wid, bounds: await this.windows.bounds(wid) };
    }
    const capture = await this.nativeCall((client) => client.capture());
    this.updateGeometry(capture.screenWidth, capture.screenHeight, capture.width, capture.height);
    const epoch = this.geometryEpoch;
    const root = { width: capture.screenWidth, height: capture.screenHeight };
    let region = options.region ?? { x: 0, y: 0, w: root.width, h: root.height };
    if (window) {
      const bounds = await this.windows.bounds(window.wid);
      if (bounds.x !== window.bounds.x || bounds.y !== window.bounds.y || bounds.width !== window.bounds.width || bounds.height !== window.bounds.height)
        throw new ApiError('stale_geometry', 'window moved or resized during capture; take a new screenshot');
      region = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
    }
    if (![region.x, region.y, region.w, region.h].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.w <= 0 || region.h <= 0 || region.x + region.w > root.width || region.y + region.h > root.height)
      throw new ApiError('invalid_request', 'capture region must fit entirely on the primary display');
    const scaleX = capture.width / root.width, scaleY = capture.height / root.height;
    const left = Math.round(region.x * scaleX), top = Math.round(region.y * scaleY);
    const width = Math.round((region.x + region.w) * scaleX) - left;
    const height = Math.round((region.y + region.h) * scaleY) - top;
    const fit = fitSize(width, height, options.max_dimension);
    const format = options.format ?? 'png';
    let image = sharp(capture.data).extract({ left, top, width, height });
    if (width !== fit.width || height !== fit.height) image = image.resize(fit.width, fit.height, { fit: 'fill' });
    if (format === 'jpeg') image = image.jpeg({ quality: options.quality ?? 80 });
    else if (format === 'webp') image = image.webp({ quality: options.quality ?? 80 });
    else image = image.png();
    const data = await image.toBuffer();
    const entry = this.registry.add({
      origin: { x: region.x, y: region.y }, scale: region.w / fit.width,
      imageSize: { width: fit.width, height: fit.height }, nativeSize: { width: region.w, height: region.h },
      root, geometryEpoch: epoch, window,
    });
    return { data, contentType: CONTENT_TYPES[format], format, entry };
  }

  private async nativeWindows() {
    const windows = await this.nativeCall((client) => client.windows());
    const present = new Set<number>();
    for (const window of windows) {
      const id = macWindowId(window.windowId);
      present.add(id);
      const previous = this.windowIdentity.get(id);
      const epoch = previous ? previous.epoch + (!previous.present || previous.pid !== window.pid ? 1 : 0) : 0;
      this.windowIdentity.set(id, { pid: window.pid, epoch, present: true });
    }
    for (const [id, entry] of this.windowIdentity) if (!present.has(id)) entry.present = false;
    return windows;
  }

  async nativeWindow(wid: number): Promise<CuaWindowInfo> {
    const id = macWindowId(wid);
    const window = (await this.nativeWindows()).find((candidate) => candidate.windowId === BigInt(id));
    if (!window) throw new ApiError('target_unavailable', `window ${hexId(id)} does not exist`);
    return window;
  }

  private windowInfo(window: CuaWindowInfo): WindowInfo {
    const id = macWindowId(window.windowId);
    return {
      id: hexId(id), epoch: this.windowIdentity.get(id)?.epoch ?? 0, title: window.title,
      app: window.appName || null, app_instance: null, pid: window.pid ?? null,
      bounds: { ...window.bounds }, focused: null, minimized: window.minimized ?? false, maximized: null,
    };
  }

  private async windowList() { return (await this.nativeWindows()).map((window) => this.windowInfo(window)); }

  private async resolveWindow(id: string | number, epoch?: number) {
    const wid = macWindowId(id);
    await this.nativeWindow(wid);
    if (epoch !== undefined && epoch !== this.windowIdentity.get(wid)?.epoch)
      throw new ApiError('stale_handle', `window ${hexId(wid)} epoch ${epoch} is stale`);
    return wid;
  }

  private async writeClipboard(content: ClipboardContent) {
    if (content.image_png_base64 !== undefined) throw unsupported('clipboard', 'image clipboard support is not implemented in the macOS pilot');
    if (content.text === undefined) throw new ApiError('invalid_request', 'provide clipboard text');
    await this.nativeCall((client) => client.clipboardWrite(content.text!));
    const generation = ++this.clipboardGeneration;
    this.bus.publish('clipboard.changed', { generation, owner_is_self: true });
    return generation;
  }

  async cursor() {
    const cursor = await this.nativeCall((client) => client.cursor());
    return { ...cursor, window: null };
  }

  private async point(request: Pick<PointerRequest, 'x' | 'y' | 'space' | 'screenshot_id' | 'window'>) {
    if (request.x === undefined && request.y === undefined) return null;
    if (request.x === undefined || request.y === undefined || !Number.isFinite(request.x) || !Number.isFinite(request.y))
      throw new ApiError('invalid_request', 'provide finite x and y coordinates');
    return resolvePoint({ ...request, x: request.x, y: request.y, window: request.window !== undefined ? macWindowId(request.window) : undefined }, {
      root: this.geometry, geometryEpoch: this.geometryEpoch, registry: this.registry,
      windowBounds: (wid) => this.windows.bounds(wid),
    });
  }

  private rejectBackground(delivery?: string) {
    if (delivery === 'background') throw new ApiError('would_require_activation', 'native pointer and keyboard actions target the foreground; use an accessibility press for background interaction');
  }

  private async finish(before: { x: number; y: number }, principal: Principal | null): Promise<InputResult> {
    const cursor = await this.nativeCall((client) => client.cursor());
    if (principal?.kind === 'agent') {
      const key = principal.id?.startsWith('mcp:') ? principal.id : principal.id ? `principal:${principal.id}` : `principal-name:${principal.name ?? 'agent'}`;
      const participant = this.presence.join({ name: principal.name ?? principal.id ?? 'agent', kind: 'agent', key });
      this.presence.cursor(participant.participant_id, cursor.x / Math.max(1, this.geometry.width - 1), cursor.y / Math.max(1, this.geometry.height - 1), true);
    }
    return { delivery: 'foreground', pointer_moved: cursor.x !== before.x || cursor.y !== before.y, focus_changed: null, cursor };
  }

  async pointerAction(request: PointerRequest, principal: Principal | null = null): Promise<InputResult> {
    this.rejectBackground(request.delivery);
    if (request.action === 'down' || request.action === 'up' || request.action === 'drag') throw unsupported('input', `native pointer ${request.action} is not implemented`);
    if (request.button === 'back' || request.button === 'forward') throw unsupported('input', `native ${request.button} mouse button is not implemented`);
    const button = request.button ?? 'left';
    if (request.modifiers?.length) throw unsupported('input', 'native pointer modifiers are not implemented');
    if (request.duration_ms) throw unsupported('input', 'native pointer motion duration is not implemented');
    if (request.unit === 'pixel') throw unsupported('input', 'native pixel scrolling is not implemented; use line units');
    return this.runInput(async () => {
      await this.refresh();
      this.requirePermission('input');
      const target = await this.point(request);
      const before = await this.nativeCall((client) => client.cursor());
      switch (request.action) {
        case 'move':
          if (!target) throw new ApiError('invalid_request', 'move requires x and y');
          await this.nativeCall((client) => client.move(target.x, target.y));
          break;
        case 'click': {
          const point = target ?? before;
          if (point.x < 0 || point.y < 0 || point.x >= this.geometry.width || point.y >= this.geometry.height) throw new ApiError('invalid_request', 'cursor is outside the primary display; provide x and y');
          await this.nativeCall((client) => client.click(point.x, point.y, button, request.count ?? 1));
          break;
        }
        case 'scroll': {
          const dx = request.dx ?? 0, dy = request.dy ?? 0;
          if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new ApiError('invalid_request', 'native line scrolling requires integer dx and dy');
          if (Math.abs(dx) + Math.abs(dy) > 200) throw new ApiError('limit_exceeded', 'scroll amount too large');
          const point = target ?? before;
          if (point.x < 0 || point.y < 0 || point.x >= this.geometry.width || point.y >= this.geometry.height) throw new ApiError('invalid_request', 'cursor is outside the primary display; provide x and y');
          await this.nativeCall((client) => client.scroll(point.x, point.y, dx, dy));
          break;
        }
        default: throw new ApiError('invalid_request', `unknown pointer action: ${request.action}`);
      }
      return this.finish(before, principal);
    });
  }

  async keyboardAction(request: KeyboardRequest, principal: Principal | null = null): Promise<InputResult> {
    this.rejectBackground(request.delivery);
    if (request.action === 'down' || request.action === 'up') throw unsupported('input', 'native held-key input is not implemented');
    if (request.mode === 'paste') throw unsupported('input', 'explicit paste mode is not implemented in the macOS pilot');
    const repeat = Math.max(1, Math.min(100, request.repeat ?? 1));
    return this.runInput(async () => {
      await this.refresh();
      this.requirePermission('input');
      const before = await this.nativeCall((client) => client.cursor());
      switch (request.action) {
        case 'type':
          if (typeof request.text !== 'string') throw new ApiError('invalid_request', 'type requires text');
          if (request.text.length > 100_000) throw new ApiError('limit_exceeded', 'text too long');
          if (request.modifiers?.length || request.delay_ms) throw unsupported('input', 'native type modifiers and per-character delay are not implemented');
          await this.nativeCall((client) => client.type(request.text!));
          break;
        case 'press':
          if (!request.key) throw new ApiError('invalid_request', 'press requires key');
          for (let i = 0; i < repeat; i++) {
            await this.nativeCall((client) => client.press(request.key!, request.modifiers ?? []));
            if (request.delay_ms) await sleep(request.delay_ms);
          }
          break;
        case 'hotkey': {
          const keys = [...request.modifiers ?? [], ...request.keys ?? (request.key ? [request.key] : [])];
          if (!keys.length) throw new ApiError('invalid_request', 'hotkey requires keys');
          for (let i = 0; i < repeat; i++) {
            await this.nativeCall((client) => client.hotkey(keys));
            if (request.delay_ms) await sleep(request.delay_ms);
          }
          break;
        }
        default: throw new ApiError('invalid_request', `unknown keyboard action: ${request.action}`);
      }
      return this.finish(before, principal);
    });
  }

  async launchApp(_command: string, _args?: string[], _env?: Record<string, string>, _cwd?: string): Promise<{ pid: number }> {
    throw unsupported('apps', 'native application launching is not implemented in the macOS pilot');
  }

  async open(_target: string): Promise<{ pid: number }> {
    throw unsupported('apps', 'native opening of URLs and files is not implemented in the macOS pilot');
  }
}
