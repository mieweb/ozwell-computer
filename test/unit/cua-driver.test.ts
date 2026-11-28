import type { CuaDriverLike, ToolResult } from '@trycua/cua-driver';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { CuaConnectionError, cuaError, SdkCuaClient, type CuaSdk } from '../../src/macos/driver.js';

const ok = (data: unknown = {}): ToolResult => ({
  text: '', images: [], structuredJson: JSON.stringify(data), isError: false, degraded: false, rawJson: '{}',
});

function fixture(options: { mode?: number; installed?: boolean; platform?: NodeJS.Platform } = {}) {
  const lifecycle: string[] = [];
  const png = new PNG({ width: 8, height: 4 });
  png.data.fill(255);
  const image = PNG.sync.write(png);
  const native = {
    isAvailable: vi.fn(() => true),
    executionMode: vi.fn(() => options.mode ?? 1),
    callTool: vi.fn(async () => ok({ accessibility: true, screen_recording: true })),
    getScreenSize: vi.fn(async () => ok({ width: 4, height: 2, scale_factor: 2 })),
    getDesktopState: vi.fn(async () => ({ ...ok({ screenshot_width: 8, screenshot_height: 4, screen_width: 4, screen_height: 2 }), images: [{ mimeType: 'image/png', dataBase64: image.toString('base64') }] })),
    getCursorPosition: vi.fn(async () => ok({ x: 1, y: 1 })),
    listWindows: vi.fn(async () => ({ windows: [] })),
    click: vi.fn(async () => ({ effect: 0, route: 0 })),
    typeText: vi.fn(async () => ok()),
    pressKey: vi.fn(async () => ok()),
    hotkey: vi.fn(async () => ok()),
    clipboardRead: vi.fn(async () => ok({ supported: true, text: 'Clipboard fixture' })),
    clipboardWrite: vi.fn(async () => ok({ supported: true })),
    getWindowState: vi.fn(async () => ({ pid: 123, windowId: 9007199254740993n, snapshotId: 'snapshot-1', images: [], elements: [] })),
    endSession: vi.fn(async () => { lifecycle.push('endSession'); return { session: 'implicit', active: false }; }),
    shutdown: vi.fn(async () => { lifecycle.push('shutdown'); }),
    uniffiDestroy: vi.fn(() => { lifecycle.push('destroy'); }),
  } satisfies Partial<CuaDriverLike> & { uniffiDestroy(): void };
  // Stand-ins for UniFFI enum constructors; the SDK/native library is never
  // loaded, so these tests run on Linux and cannot touch the user's desktop.
  const variant = (tag: string) => class {
    readonly tag = tag;
    constructor(readonly inner: unknown) {}
  };
  const create = vi.fn(() => native);
  const sdk = {
    CuaDriver: { create },
    ActionTarget: { Desktop: variant('Desktop'), Window: variant('Window') },
    ClickPosition: { Coordinates: variant('Coordinates'), Element: variant('Element') },
    InputDeliveryMode: { Background: 0, Foreground: 1 },
    ClickButton: { Left: 0, Right: 1, Middle: 2 },
    DriverExecutionMode: { Embedded: 0, Daemon: 1 },
  } as unknown as CuaSdk;
  const loadSdk = vi.fn(async () => sdk);
  const client = new SdkCuaClient({ loadSdk, platform: options.platform ?? 'darwin', appInstalled: () => options.installed ?? true });
  return { client, native, create, loadSdk, lifecycle, image };
}

describe('native Cua SDK boundary', () => {
  it('loads lazily and rejects unsupported hosts or missing signed helpers before native import', async () => {
    const linux = fixture({ platform: 'linux' });
    expect(linux.loadSdk).not.toHaveBeenCalled();
    await expect(linux.client.start()).rejects.toMatchObject({ reason: 'feature_unsupported' });
    expect(linux.loadSdk).not.toHaveBeenCalled();
    const missing = fixture({ installed: false });
    await expect(missing.client.start()).rejects.toThrow('CuaDriver.app');
    expect(missing.loadSdk).not.toHaveBeenCalled();
  });

  it('coalesces startup and checks daemon permissions without prompting', async () => {
    const { client, native, loadSdk, create } = fixture();
    await Promise.all([client.start(), client.start()]);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith();
    expect(native.callTool).toHaveBeenCalledWith('check_permissions', JSON.stringify({ prompt: false, probe_direct_capture: false }));
    expect(await client.permissions()).toEqual({ accessibility: true, screenRecording: true });
    await client.stop();
  });

  it('refuses embedded fallback and releases its handle', async () => {
    const { client, native, lifecycle } = fixture({ mode: 0 });
    await expect(client.start()).rejects.toThrow('embedded fallback is disabled');
    expect(native.callTool).not.toHaveBeenCalled();
    expect(lifecycle).toEqual(['shutdown', 'destroy']);
    await client.stop();
    expect(lifecycle).toEqual(['shutdown', 'destroy']);
  });

  it('reports missing optional SDK dependencies clearly', async () => {
    const client = new SdkCuaClient({ platform: 'darwin', appInstalled: () => true, loadSdk: async () => { throw new Error('native module missing'); } });
    await expect(client.start()).rejects.toThrow('npm ci with optional dependencies enabled');
  });

  it('preserves permission errors and shuts down after startup failure', async () => {
    const { client, native, lifecycle } = fixture();
    native.callTool.mockResolvedValueOnce({ ...ok(), text: 'Accessibility permission denied', isError: true, errorCode: 'permission_denied' });
    await expect(client.start()).rejects.toMatchObject({ reason: 'permission_denied' });
    expect(lifecycle).toEqual(['shutdown', 'destroy']);
  });

  it('keeps logical screen size separate from native capture pixels', async () => {
    const { client, native, image } = fixture();
    await client.start();
    expect(await client.screen()).toEqual({ width: 4, height: 2, pixelWidth: 8, pixelHeight: 4, scale: 2 });
    expect(await client.capture()).toEqual({ data: image, width: 8, height: 4, screenWidth: 4, screenHeight: 2 });
    expect(native.getDesktopState).toHaveBeenCalledWith({ maxImageDimension: 0 });
    expect(await client.cursor()).toEqual({ x: 1, y: 1 });
    await client.stop();
  });

  it('rejects mismatched capture metadata', async () => {
    const { client, native, image } = fixture();
    await client.start();
    native.getDesktopState.mockResolvedValueOnce({ ...ok({ screenshot_width: 4, screenshot_height: 2, screen_width: 4, screen_height: 2 }), images: [{ mimeType: 'image/png', dataBase64: image.toString('base64') }] });
    await expect(client.capture()).rejects.toThrow('dimensions do not match');
    await client.stop();
  });

  it('scales desktop input to Retina pixels and explicitly chooses foreground delivery', async () => {
    const { client, native } = fixture();
    await client.start();
    await client.click(1, 0.5, 'right', 2);
    expect(native.click).toHaveBeenCalledWith({
      target: expect.objectContaining({ tag: 'Desktop', inner: { displayId: 'primary' } }),
      position: expect.objectContaining({ tag: 'Coordinates', inner: { x: 2, y: 1 } }),
      deliveryMode: 1, button: 1, count: 2,
    });
    await client.move(1, 0.5);
    expect(native.callTool).toHaveBeenCalledWith('move_cursor', JSON.stringify({ x: 2, y: 1, scope: 'desktop', delivery_mode: 'foreground' }));
    await client.scroll(1, 0.5, -2, 3);
    expect(native.callTool).toHaveBeenCalledWith('scroll', JSON.stringify({ x: 2, y: 1, direction: 'left', by: 'line', amount: 2, scope: 'desktop', delivery_mode: 'foreground' }));
    expect(native.callTool).toHaveBeenCalledWith('scroll', JSON.stringify({ x: 2, y: 1, direction: 'down', by: 'line', amount: 3, scope: 'desktop', delivery_mode: 'foreground' }));
    await client.stop();
  });

  it('validates both scroll axes before delivering either one', async () => {
    const { client, native } = fixture();
    await client.start();
    native.callTool.mockClear();
    await expect(client.scroll(0, 0, 1, 51)).rejects.toMatchObject({ reason: 'invalid_request' });
    expect(native.callTool).not.toHaveBeenCalled();
    await client.stop();
  });

  it('keeps keyboard input addressed to the primary desktop and supports text clipboard', async () => {
    const { client, native } = fixture();
    await client.start();
    const target = expect.objectContaining({ tag: 'Desktop', inner: { displayId: 'primary' } });
    await client.type('fixture');
    expect(native.typeText).toHaveBeenCalledWith({ target, text: 'fixture' });
    await client.press('Return', ['shift']);
    expect(native.pressKey).toHaveBeenCalledWith({ target, key: 'Return', modifiers: ['shift'] });
    await client.hotkey(['cmd', 'a']);
    expect(native.hotkey).toHaveBeenCalledWith({ target, keys: ['cmd', 'a'] });
    expect(await client.clipboardRead()).toEqual({ text: 'Clipboard fixture' });
    await client.clipboardWrite('new fixture');
    expect(native.clipboardWrite).toHaveBeenCalledWith({ text: 'new fixture' });
    await client.stop();
  });

  it('binds accessibility tokens to an exact fresh window snapshot without activation fallback', async () => {
    const { client, native } = fixture();
    await client.start();
    const windowId = 9007199254740993n;
    await client.windowState(123, windowId, { maxElements: 10, maxDepth: 2 });
    expect(native.getWindowState).toHaveBeenCalledWith({ pid: 123, windowId, maxElements: 10, maxDepth: 2, includeAccessibilityTree: true, includeScreenshot: false, maxImageDimension: 0, treeFormat: 'elements' });
    await client.pressElement(123, windowId, 'snapshot-1:2', 'snapshot-1');
    expect(native.click).toHaveBeenCalledWith({
      target: expect.objectContaining({ tag: 'Window', inner: { pid: 123, windowId } }),
      position: expect.objectContaining({ tag: 'Element', inner: { elementToken: 'snapshot-1:2' } }),
      deliveryMode: 0, button: 0, count: 1,
    });
    native.getWindowState.mockResolvedValueOnce({ pid: 123, windowId, snapshotId: 'snapshot-2', images: [], elements: [] });
    await client.windowState(123, windowId);
    await expect(client.pressElement(123, windowId, 'snapshot-1:2', 'snapshot-1')).rejects.toMatchObject({ reason: 'stale_snapshot' });
    expect(native.click).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it('never retries an action after an SDK refusal or uncertain completion', async () => {
    const { client, native } = fixture();
    await client.start();
    native.click.mockRejectedValueOnce({ tag: 'Tool', inner: { errorCode: 'stale_element_token', message: 'Element token is stale' } });
    await expect(client.click(1, 1)).rejects.toMatchObject({ reason: 'stale_snapshot' });
    expect(native.click).toHaveBeenCalledTimes(1);
    native.click.mockRejectedValueOnce({ tag: 'ActionInterrupted', inner: { message: 'Action completion unknown; inspect the UI before retrying' } });
    await expect(client.click(1, 1)).rejects.toThrow('completion unknown');
    expect(native.click).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('releases a disconnected client and reconnects only for a later request', async () => {
    const { client, native, create, lifecycle } = fixture();
    const replacement = fixture();
    await client.start();
    await client.windowState(123, 9007199254740993n);
    const failure = { tag: 'Transport', inner: { reason: 'Daemon connection closed' } };
    native.click.mockRejectedValueOnce(failure);
    // Cleanup failure must not replace the action failure or prevent recovery.
    native.shutdown.mockImplementationOnce(async () => { lifecycle.push('shutdown'); throw new Error('already disconnected'); });
    await expect(client.click(1, 1)).rejects.toMatchObject({ reason: 'target_unavailable', cause: failure });
    expect(native.click).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(['shutdown', 'destroy']);
    expect(native.endSession).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockReturnValueOnce(replacement.native);
    await client.start();
    expect(create).toHaveBeenCalledTimes(2);
    await expect(client.pressElement(123, 9007199254740993n, 'old-token', 'snapshot-1')).rejects.toMatchObject({ reason: 'stale_snapshot' });
    expect(replacement.native.click).not.toHaveBeenCalled();
    await client.click(1, 1);
    expect(replacement.native.click).toHaveBeenCalledTimes(1);
    await client.stop();
    expect(lifecycle).toEqual(['shutdown', 'destroy']);
  });

  it('releases a connection that fails during startup exactly once', async () => {
    const { client, native, create, lifecycle } = fixture();
    native.callTool.mockRejectedValueOnce({ tag: 'Protocol', inner: { reason: 'Daemon disconnected during permission check' } });
    await expect(client.start()).rejects.toBeInstanceOf(CuaConnectionError);
    expect(lifecycle).toEqual(['shutdown', 'destroy']);
    await client.start();
    expect(create).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('keeps the connection after an unavailable window refusal', async () => {
    const { client, native, create, lifecycle } = fixture();
    await client.start();
    native.click.mockRejectedValueOnce({ tag: 'Tool', inner: { errorCode: 'window_not_found', message: 'Requested window does not exist' } });
    await expect(client.click(1, 1)).rejects.toMatchObject({ reason: 'target_unavailable' });
    expect(lifecycle).toEqual([]);
    await client.start();
    await client.click(1, 1);
    expect(create).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it('destroys the native handle after shutdown even when shutdown rejects', async () => {
    const { client, native, lifecycle } = fixture();
    await client.start();
    native.shutdown.mockImplementationOnce(async () => { lifecycle.push('shutdown'); throw new Error('shutdown failure'); });
    await expect(client.stop()).rejects.toThrow('shutdown failure');
    expect(lifecycle).toEqual(['endSession', 'shutdown', 'destroy']);
    await client.stop();
    expect(lifecycle).toEqual(['endSession', 'shutdown', 'destroy']);
  });

  it('releases the binding even when ending its daemon session fails', async () => {
    const { client, native, lifecycle } = fixture();
    await client.start();
    native.endSession.mockImplementationOnce(async () => { lifecycle.push('endSession'); throw new Error('daemon disconnected'); });
    await expect(client.stop()).rejects.toThrow('daemon disconnected');
    expect(lifecycle).toEqual(['endSession', 'shutdown', 'destroy']);
  });
});

describe('Cua error normalization', () => {
  it('preserves transport failure identity separately from missing targets', () => {
    for (const failure of [
      { tag: 'Transport', inner: { reason: 'Connection closed' } },
      { tag: 'Protocol', inner: { reason: 'Invalid daemon response' } },
      { code: 'ECONNRESET', message: 'Connection reset' },
    ]) {
      const error = cuaError(failure);
      expect(error).toBeInstanceOf(CuaConnectionError);
      expect(error).toMatchObject({ reason: 'target_unavailable', cause: failure });
      expect(cuaError(error)).toBe(error);
    }
    expect(cuaError({ errorCode: 'window_not_found', message: 'No such window' })).not.toBeInstanceOf(CuaConnectionError);
  });

  it('maps native refusals to existing API errors', () => {
    expect(cuaError({ errorCode: 'permission_denied', message: 'Screen Recording denied' }).reason).toBe('permission_denied');
    expect(cuaError({ errorCode: 'stale_element_token', message: 'Stale element token' }).reason).toBe('stale_snapshot');
    expect(cuaError({ errorCode: 'capture_expired', message: 'Capture expired' }).reason).toBe('stale_geometry');
    expect(cuaError({ errorCode: 'facility_unavailable', message: 'Overlay unsupported' }).reason).toBe('feature_unsupported');
    expect(cuaError({ tag: 'InvalidArguments', inner: { reason: 'Bad key' } }).reason).toBe('invalid_request');
  });
});
