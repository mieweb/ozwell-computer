import { existsSync } from 'node:fs';
import sharp from 'sharp';
import type {
  ActionResult, CuaDriverLike, GetWindowStateInput, ToolResult, WindowInfo, WindowStateOutput,
} from '@trycua/cua-driver';
import { ApiError, unsupported } from '../errors.js';

export type { WindowInfo, WindowStateOutput } from '@trycua/cua-driver';

export interface CuaScreen {
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
}
export interface CuaCapture {
  data: Buffer;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}
export interface CuaPermissions { accessibility: boolean; screenRecording: boolean }
export type CuaButton = 'left' | 'right' | 'middle';
export type CuaWindowOptions = Pick<GetWindowStateInput, 'maxElements' | 'maxDepth'>;

/** All coordinates crossing this boundary are macOS logical points, except image sizes. */
export interface CuaClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  permissions(): Promise<CuaPermissions>;
  screen(): Promise<CuaScreen>;
  capture(): Promise<CuaCapture>;
  windows(): Promise<WindowInfo[]>;
  cursor(): Promise<{ x: number; y: number }>;
  click(x: number, y: number, button?: CuaButton, count?: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, modifiers?: string[]): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
  clipboardRead(): Promise<{ text?: string }>;
  clipboardWrite(text: string): Promise<void>;
  windowState(pid: number, windowId: bigint, options?: CuaWindowOptions): Promise<WindowStateOutput>;
  pressElement(pid: number, windowId: bigint, token: string, snapshotId: string): Promise<ActionResult>;
}
export type CuaClientFactory = () => CuaClient;

type Sdk = typeof import('@trycua/cua-driver');
export type CuaSdk = Pick<Sdk,
  'CuaDriver' | 'ActionTarget' | 'ClickPosition' | 'InputDeliveryMode' | 'ClickButton' | 'DriverExecutionMode'>;
export type CuaSdkLoader = () => Promise<CuaSdk>;
type NativeDriver = CuaDriverLike & { uniffiDestroy?: () => void };

/** No native module is imported until the explicitly selected Mac backend starts. */
const loadSdk: CuaSdkLoader = () => import('@trycua/cua-driver');
const SETUP = 'Install CuaDriver.app and run `cua-driver permissions grant`, then enable Accessibility and Screen & System Audio Recording for CuaDriver in System Settings and relaunch it.';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Connection failures must remain distinguishable from an unavailable window. */
export class CuaConnectionError extends ApiError {
  constructor(message: string, feature: string, readonly cause: unknown) {
    super('target_unavailable', message, { feature });
    this.name = 'CuaConnectionError';
  }
}

/** Preserve SDK refusals without retrying an action whose completion could be unknown. */
export function cuaError(error: unknown, feature = 'macos'): ApiError {
  if (error instanceof ApiError) return error;
  const e = record(error), inner = record(e.inner);
  const code = String(inner.errorCode ?? e.errorCode ?? e.code ?? '');
  const message = String(inner.message ?? inner.reason ?? e.message ?? error);
  const detail = `${code} ${message}`;
  if (e.tag === 'Transport' || e.tag === 'Protocol' || /^(?:ECONNRESET|ECONNREFUSED|ENOTCONN|EPIPE)$/.test(code)) {
    return new CuaConnectionError(`Cua Driver: ${message}`, feature, error);
  }
  if (/permission|accessibility.*(?:grant|denied)|screen.*record.*(?:grant|denied)|tcc/i.test(detail)) {
    return new ApiError('permission_denied', `Cua Driver: ${message}. ${SETUP}`, { feature });
  }
  if (/stale.*(?:token|element)|(?:token|element).*stale|snapshot.*(?:expired|stale)|expired.*snapshot/i.test(detail)) {
    return new ApiError('stale_snapshot', `Cua Driver: ${message}`, { feature });
  }
  if (/stale.*capture|capture.*(?:stale|expired)|generation_mismatch/i.test(detail)) {
    return new ApiError('stale_geometry', `Cua Driver: ${message}`, { feature });
  }
  if (/unsupported|unavailable.*(?:feature|facility)|facility_unavailable|not_supported/i.test(detail)) {
    return unsupported(feature, `Cua Driver: ${message}`);
  }
  if (/invalid.*(?:argument|target|request)|InvalidArguments/.test(`${e.tag} ${detail}`)) {
    return new ApiError('invalid_request', `Cua Driver: ${message}`, { feature });
  }
  if (/window_not_found|target_unavailable|no.*(?:window|display)/.test(detail)) {
    return new ApiError('target_unavailable', `Cua Driver: ${message}`, { feature });
  }
  return new ApiError('internal', `Cua Driver: ${message}`, { feature });
}

function checked(result: ToolResult, feature: string): ToolResult {
  if (result.isError) throw cuaError({ message: result.text, errorCode: result.errorCode }, feature);
  if (result.action?.error) throw cuaError({ message: result.action.summary ?? result.text, errorCode: result.action.error.code }, feature);
  return result;
}

function structured(result: ToolResult, feature: string): Record<string, unknown> {
  checked(result, feature);
  try {
    if (!result.structuredJson) throw new Error('missing structured result');
    return record(JSON.parse(result.structuredJson));
  } catch {
    throw new ApiError('internal', `Cua Driver returned invalid ${feature} metadata`, { feature });
  }
}

function dimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ApiError('internal', `Cua Driver returned an invalid ${name}`, { feature: 'screenshot' });
  }
  return value;
}

/** Thin translation of the pinned 0.38.0 native SDK; no shell or subprocess bridge. */
export class SdkCuaClient implements CuaClient {
  private sdk?: CuaSdk;
  private driver?: NativeDriver;
  private starting?: Promise<void>;
  private disconnecting?: Promise<void>;
  private readonly snapshots = new Map<string, string>();

  constructor(private readonly options: {
    loadSdk?: CuaSdkLoader;
    platform?: NodeJS.Platform;
    appInstalled?: () => boolean;
  } = {}) {}

  async start(): Promise<void> {
    if (this.disconnecting) await this.disconnecting;
    if (this.starting) return this.starting;
    if (this.driver) return;
    this.starting = this.initialize();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async initialize(): Promise<void> {
    if ((this.options.platform ?? process.platform) !== 'darwin') {
      throw unsupported('macos', 'The native macOS backend requires macOS. Use the X11 backend on Linux.');
    }
    if (!(this.options.appInstalled ?? (() => existsSync('/Applications/CuaDriver.app')))()) {
      throw unsupported('macos', `CuaDriver.app is not installed in /Applications. ${SETUP}`);
    }
    let sdk: CuaSdk;
    try { sdk = await (this.options.loadSdk ?? loadSdk)(); }
    catch (error) {
      throw unsupported('macos', `Unable to load @trycua/cua-driver 0.38.0 for this Mac. Run npm ci with optional dependencies enabled. ${String(record(error).message ?? error)}`);
    }
    let driver: NativeDriver | undefined;
    let assigned = false;
    try {
      driver = sdk.CuaDriver.create() as NativeDriver;
      // create() can silently fall back to an embedded runtime. The pilot relies
      // on the signed helper's permissions and must never change their owner.
      if (driver.executionMode() !== sdk.DriverExecutionMode.Daemon || !driver.isAvailable()) {
        throw unsupported('macos', 'CuaDriver.app is not reachable. Start the signed helper with `cua-driver permissions grant` and relaunch Ozwell; embedded fallback is disabled for this pilot.');
      }
      this.sdk = sdk;
      this.driver = driver;
      assigned = true;
      await this.permissions();
    } catch (error) {
      // invoke() already releases a handle that lost its connection during the
      // permission check. Do not destroy that same native handle twice.
      const ownsHandle = !assigned || this.driver === driver;
      if (ownsHandle) {
        this.sdk = undefined;
        this.driver = undefined;
      }
      if (driver && ownsHandle) {
        try { await driver.shutdown(); } catch { /* preserve the startup failure */ }
        finally { driver.uniffiDestroy?.(); }
      }
      throw cuaError(error);
    }
  }

  async stop(): Promise<void> {
    if (this.starting) {
      try { await this.starting; } catch { /* initialize already released its handle */ }
    }
    if (this.disconnecting) await this.disconnecting;
    const driver = this.driver;
    this.driver = undefined;
    this.sdk = undefined;
    this.snapshots.clear();
    if (driver) {
      // A daemon client does not own the helper. End only this client's implicit
      // session (and its cursor), then release the local binding handle.
      try { await driver.endSession({}); }
      finally {
        try { await driver.shutdown(); } finally { driver.uniffiDestroy?.(); }
      }
    }
  }

  private native(): { driver: NativeDriver; sdk: CuaSdk } {
    if (!this.driver || !this.sdk) throw new CuaConnectionError('Cua Driver is not started', 'macos', undefined);
    return { driver: this.driver, sdk: this.sdk };
  }

  private async invoke<T>(feature: string, operation: (driver: NativeDriver, sdk: CuaSdk) => Promise<T>): Promise<T> {
    const { driver, sdk } = this.native();
    try { return await operation(driver, sdk); } catch (error) {
      const normalized = cuaError(error, feature);
      if (normalized instanceof CuaConnectionError && this.driver === driver) {
        this.driver = undefined;
        this.sdk = undefined;
        this.snapshots.clear();
        // Release only this local binding. Ending a daemon session over the
        // failed transport could reconnect; the failed operation is never retried.
        const cleanup = (async () => {
          try { await driver.shutdown(); } catch { /* preserve the operation failure */ }
          finally { try { driver.uniffiDestroy?.(); } catch { /* preserve the operation failure */ } }
        })();
        this.disconnecting = cleanup;
        try { await cleanup; } finally {
          if (this.disconnecting === cleanup) this.disconnecting = undefined;
        }
      }
      throw normalized;
    }
  }

  async permissions(): Promise<CuaPermissions> {
    return this.invoke('permissions', async driver => {
      // Generic SDK surface is required: 0.38.0 has no typed checkPermissions.
      // This read-only check deliberately never raises OS consent prompts.
      const data = structured(await driver.callTool('check_permissions', JSON.stringify({ prompt: false, probe_direct_capture: false })), 'permissions');
      return { accessibility: data.accessibility === true, screenRecording: data.screen_recording === true };
    });
  }

  async screen(): Promise<CuaScreen> {
    return this.invoke('screenshot', async driver => {
      const data = structured(await driver.getScreenSize({}), 'screenshot');
      const width = dimension(data.width, 'screen width');
      const height = dimension(data.height, 'screen height');
      const scale = dimension(data.scale_factor, 'screen scale');
      return { width, height, scale, pixelWidth: Math.round(width * scale), pixelHeight: Math.round(height * scale) };
    });
  }

  async capture(): Promise<CuaCapture> {
    return this.invoke('screenshot', async driver => {
      // Zero prevents Cua's per-session downsize cache from changing later input.
      const result = checked(await driver.getDesktopState({ maxImageDimension: 0 }), 'screenshot');
      const metadata = structured(result, 'screenshot');
      const image = result.images.find(image => image.mimeType === 'image/png');
      if (!image) throw new ApiError('internal', 'Cua Driver returned no PNG screenshot', { feature: 'screenshot' });
      const data = Buffer.from(image.dataBase64, 'base64');
      const actual = await sharp(data).metadata();
      const width = dimension(metadata.screenshot_width, 'screenshot width');
      const height = dimension(metadata.screenshot_height, 'screenshot height');
      if (actual.width !== width || actual.height !== height) {
        throw new ApiError('internal', 'Cua Driver screenshot dimensions do not match its metadata', { feature: 'screenshot' });
      }
      return { data, width, height, screenWidth: dimension(metadata.screen_width, 'screen width'), screenHeight: dimension(metadata.screen_height, 'screen height') };
    });
  }

  async windows(): Promise<WindowInfo[]> {
    return this.invoke('windows', async driver => (await driver.listWindows({})).windows);
  }

  async cursor(): Promise<{ x: number; y: number }> {
    return this.invoke('input', async driver => {
      const data = structured(await driver.getCursorPosition({}), 'input');
      if (typeof data.x !== 'number' || typeof data.y !== 'number' || !Number.isFinite(data.x) || !Number.isFinite(data.y)) {
        throw new ApiError('internal', 'Cua Driver returned invalid cursor coordinates', { feature: 'input' });
      }
      return { x: data.x, y: data.y };
    });
  }

  private async pixels(x: number, y: number): Promise<{ x: number; y: number }> {
    const screen = await this.screen();
    return { x: x * screen.scale, y: y * screen.scale };
  }

  async click(x: number, y: number, button: CuaButton = 'left', count = 1): Promise<void> {
    const point = await this.pixels(x, y);
    await this.invoke('input', async (driver, sdk) => {
      const result = await driver.click({
        target: new sdk.ActionTarget.Desktop({ displayId: 'primary' }),
        position: new sdk.ClickPosition.Coordinates(point),
        deliveryMode: sdk.InputDeliveryMode.Foreground,
        button: { left: sdk.ClickButton.Left, right: sdk.ClickButton.Right, middle: sdk.ClickButton.Middle }[button], count,
      });
      if (result.error) throw cuaError({ errorCode: result.error.code, message: result.summary ?? result.error.hint ?? 'Click refused' }, 'input');
    });
  }

  async move(x: number, y: number): Promise<void> {
    const point = await this.pixels(x, y);
    await this.desktopTool('move_cursor', point);
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    if (![dx, dy].every(value => Number.isFinite(value) && Math.abs(value) <= 50)) {
      throw new ApiError('invalid_request', 'Native macOS scroll supports at most 50 lines per axis per request', { feature: 'input' });
    }
    const point = await this.pixels(x, y);
    for (const [value, negative, positive] of [[dx, 'left', 'right'], [dy, 'up', 'down']] as const) {
      if (value === 0) continue;
      // The native tool accepts whole wheel notches, with one as its minimum.
      const amount = Math.ceil(Math.abs(value));
      await this.desktopTool('scroll', { ...point, direction: value < 0 ? negative : positive, by: 'line', amount });
    }
  }

  private async desktopTool(name: 'move_cursor' | 'scroll', args: Record<string, unknown>): Promise<void> {
    await this.invoke('input', async driver => {
      // Typed move/scroll inputs currently omit delivery_mode; the verified
      // generic SDK contract lets this foreground-only pilot state it explicitly.
      checked(await driver.callTool(name, JSON.stringify({ ...args, scope: 'desktop', delivery_mode: 'foreground' })), 'input');
    });
  }

  async type(text: string): Promise<void> {
    await this.invoke('input', async (driver, sdk) => {
      checked(await driver.typeText({ text, target: new sdk.ActionTarget.Desktop({ displayId: 'primary' }) }), 'input');
    });
  }

  async press(key: string, modifiers?: string[]): Promise<void> {
    await this.invoke('input', async (driver, sdk) => {
      checked(await driver.pressKey({ key, modifiers, target: new sdk.ActionTarget.Desktop({ displayId: 'primary' }) }), 'input');
    });
  }

  async hotkey(keys: string[]): Promise<void> {
    await this.invoke('input', async (driver, sdk) => {
      checked(await driver.hotkey({ keys, target: new sdk.ActionTarget.Desktop({ displayId: 'primary' }) }), 'input');
    });
  }

  async clipboardRead(): Promise<{ text?: string }> {
    return this.invoke('clipboard', async driver => {
      const data = structured(await driver.clipboardRead({ includeText: true }), 'clipboard');
      if (data.supported !== true) throw unsupported('clipboard', 'Cua Driver does not support the native clipboard');
      return { ...(typeof data.text === 'string' ? { text: data.text } : {}) };
    });
  }

  async clipboardWrite(text: string): Promise<void> {
    await this.invoke('clipboard', async driver => { checked(await driver.clipboardWrite({ text }), 'clipboard'); });
  }

  async windowState(pid: number, windowId: bigint, options: CuaWindowOptions = {}): Promise<WindowStateOutput> {
    return this.invoke('a11y', async driver => {
      const result = await driver.getWindowState({
        pid, windowId, ...options, includeAccessibilityTree: true, includeScreenshot: false,
        maxImageDimension: 0, treeFormat: 'elements',
      });
      const key = `${pid}:${windowId}`;
      if (result.snapshotId) this.snapshots.set(key, result.snapshotId);
      else this.snapshots.delete(key);
      return result;
    });
  }

  async pressElement(pid: number, windowId: bigint, token: string, snapshotId: string): Promise<ActionResult> {
    if (this.snapshots.get(`${pid}:${windowId}`) !== snapshotId) {
      throw new ApiError('stale_snapshot', 'Refresh the accessibility snapshot for this exact window before acting', { feature: 'a11y' });
    }
    // Tokens are bound to the native snapshot/window/session. Never synthesize a
    // coordinate fallback for a refused or stale accessibility token.
    return this.invoke('a11y', async (driver, sdk) => {
      const result = await driver.click({
        target: new sdk.ActionTarget.Window({ pid, windowId }),
        position: new sdk.ClickPosition.Element({ elementToken: token }),
        deliveryMode: sdk.InputDeliveryMode.Background,
        button: sdk.ClickButton.Left, count: 1,
      });
      if (result.error) throw cuaError({ errorCode: result.error.code, message: result.summary ?? result.error.hint ?? 'Accessibility press refused' }, 'a11y');
      return result;
    });
  }
}

export const createCuaClient: CuaClientFactory = () => new SdkCuaClient();
