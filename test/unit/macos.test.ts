import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import sharp from 'sharp';
import { ApiError } from '../../src/errors.js';
import { MacDesktop, macWindowId } from '../../src/macos/desktop.js';
import { MacA11y } from '../../src/macos/a11y.js';
import { CuaConnectionError } from '../../src/macos/driver.js';
import type { CuaClient, WindowInfo, WindowStateOutput } from '../../src/macos/driver.js';
import type { PointerRequest } from '../../src/desktop.js';

const log = pino({ level: 'silent' });
const desktops: MacDesktop[] = [];
afterEach(async () => { await Promise.all(desktops.splice(0).map((desktop) => desktop.stop())); });

async function fixture() {
  const image = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#cccccc' } }).png().toBuffer();
  const window: WindowInfo = { windowId: 42n, pid: 100, appName: 'Test app', title: 'Example', bounds: { x: 10, y: 5, width: 40, height: 20 }, isOnScreen: true };
  const state: WindowStateOutput = { pid: 100, windowId: 42n, snapshotId: 'native1', appName: 'Test app', elementsComplete: true, images: [], elements: [
    { elementIndex: 1n, depth: 0, role: 'AXWindow', label: 'Example' },
    { elementIndex: 2n, parentIndex: 1n, depth: 1, role: 'AXButton', label: 'Save', enabled: true, actions: ['AXPress'], elementToken: 'exact-token', frame: { x: 12, y: 10, w: 20, h: 10 } },
  ] };
  let cursor = { x: 0, y: 0 };
  const client = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    permissions: vi.fn(async () => ({ accessibility: true, screenRecording: true })),
    screen: vi.fn(async () => ({ width: 100, height: 50, pixelWidth: 200, pixelHeight: 100, scale: 2 })),
    capture: vi.fn(async () => ({ data: image, width: 200, height: 100, screenWidth: 100, screenHeight: 50 })),
    windows: vi.fn(async (): Promise<WindowInfo[]> => [window]), cursor: vi.fn(async () => ({ ...cursor })),
    click: vi.fn(async (x: number, y: number) => { cursor = { x, y }; }),
    move: vi.fn(async (x: number, y: number) => { cursor = { x, y }; }),
    scroll: vi.fn(async () => {}), type: vi.fn(async () => {}), press: vi.fn(async () => {}), hotkey: vi.fn(async () => {}),
    clipboardRead: vi.fn(async () => ({ text: 'hello' })), clipboardWrite: vi.fn(async () => {}),
    windowState: vi.fn(async (): Promise<WindowStateOutput> => state),
    pressElement: vi.fn(async () => ({ effect: 0, route: 0 })),
  } satisfies CuaClient;
  const desktop = new MacDesktop(log, client);
  desktops.push(desktop);
  await desktop.start();
  return { desktop, client, window, state };
}

describe('macOS logical display and screenshot coordinates', () => {
  it('maps a full Retina capture from raster pixels into logical input points', async () => {
    const { desktop, client } = await fixture();
    const screenshot = await desktop.screenshot();
    expect(screenshot.entry.imageSize).toEqual({ width: 200, height: 100 });
    expect(screenshot.entry.nativeSize).toEqual({ width: 100, height: 50 });
    expect(screenshot.entry.scale).toBe(0.5);
    await desktop.pointerAction({ action: 'click', x: 100, y: 50, screenshot_id: screenshot.entry.id });
    expect(client.click).toHaveBeenCalledWith(50, 25, 'left', 1);
    expect((await desktop.displays())[0].scale).toBe(2);
  });

  it('retains cropped origin and scale after downsampling a window screenshot', async () => {
    const { desktop, client } = await fixture();
    const screenshot = await desktop.screenshot({ window: '0x2a', max_dimension: 40, format: 'webp' });
    expect(screenshot.contentType).toBe('image/webp');
    expect(screenshot.entry.origin).toEqual({ x: 10, y: 5 });
    expect(screenshot.entry.nativeSize).toEqual({ width: 40, height: 20 });
    expect(screenshot.entry.imageSize).toEqual({ width: 40, height: 20 });
    await desktop.pointerAction({ action: 'move', x: 20, y: 10, screenshot_id: screenshot.entry.id });
    expect(client.move).toHaveBeenCalledWith(30, 15);
  });

  it('rejects stale display geometry and moved window targets before delivering input', async () => {
    const { desktop, client, window } = await fixture();
    const screenshot = await desktop.screenshot({ window: '42' });
    window.bounds.x = 20;
    await expect(desktop.pointerAction({ action: 'click', x: 1, y: 1, screenshot_id: screenshot.entry.id })).rejects.toMatchObject({ reason: 'stale_geometry' });
    const full = await desktop.screenshot();
    client.screen.mockResolvedValue({ width: 120, height: 50, pixelWidth: 240, pixelHeight: 100, scale: 2 });
    await expect(desktop.pointerAction({ action: 'click', x: 1, y: 1, screenshot_id: full.entry.id })).rejects.toMatchObject({ reason: 'stale_geometry' });
    expect(client.click).not.toHaveBeenCalled();
  });

  it('rejects secondary-display capture and normalized out-of-screen input', async () => {
    const { desktop, client, window } = await fixture();
    window.bounds.x = -20;
    await expect(desktop.screenshot({ window: '42' })).rejects.toMatchObject({ reason: 'invalid_request' });
    await expect(desktop.pointerAction({ action: 'click', x: 2, y: 0, space: 'normalized' })).rejects.toMatchObject({ reason: 'invalid_request' });
    expect(client.click).not.toHaveBeenCalled();
  });

  it('rejects a window that moves while its screen frame is being captured', async () => {
    const { desktop, client, window } = await fixture();
    const capture = await client.capture();
    client.capture.mockImplementationOnce(async () => { window.bounds.x = 20; return capture; });
    await expect(desktop.screenshot({ window: '42' })).rejects.toMatchObject({ reason: 'stale_geometry' });
  });

  it('rejects OCR before capturing instead of silently returning an image without text', async () => {
    const { desktop, client } = await fixture();
    await expect(desktop.screenshot({ ocr: true })).rejects.toMatchObject({ reason: 'feature_unsupported' });
    expect(client.capture).not.toHaveBeenCalled();
  });
});

describe('macOS native actions', () => {
  it('marks a disconnected desktop unavailable and reconnects before the next action without replaying', async () => {
    const { desktop, client } = await fixture();
    const failure = new CuaConnectionError('Daemon connection closed', 'input', { tag: 'Transport' });
    client.click.mockRejectedValueOnce(failure);
    await expect(desktop.pointerAction({ action: 'click', x: 5, y: 5 })).rejects.toBe(failure);
    expect(client.click).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
    const status = desktop.status();
    expect(status.display).toMatchObject({ connected: false, error: 'Daemon connection closed' });
    for (const feature of ['screenshot', 'input', 'clipboard', 'windows'] as const)
      expect(status.features[feature].available).toBe(false);

    await desktop.pointerAction({ action: 'click', x: 6, y: 6 });
    expect(client.start).toHaveBeenCalledTimes(2);
    expect(client.click).toHaveBeenNthCalledWith(2, 6, 6, 'left', 1);
    expect(desktop.status().display).toMatchObject({ connected: true, error: null });
    expect(desktop.status().features.input.available).toBe(true);
  });

  it('serializes concurrent pointer and keyboard requests and recovers the queue after a refusal', async () => {
    const { desktop, client } = await fixture();
    const events: string[] = [];
    let release!: () => void;
    client.type.mockImplementationOnce(async () => { events.push('type start'); await new Promise<void>((resolve) => { release = resolve; }); events.push('type end'); });
    client.click.mockImplementationOnce(async () => { events.push('click'); });
    const typing = desktop.keyboardAction({ action: 'type', text: 'first' });
    await vi.waitFor(() => expect(events).toEqual(['type start']));
    const clicking = desktop.pointerAction({ action: 'click', x: 5, y: 5 });
    await Promise.resolve();
    expect(events).toEqual(['type start']);
    release();
    await Promise.all([typing, clicking]);
    expect(events).toEqual(['type start', 'type end', 'click']);
    client.press.mockRejectedValueOnce(new ApiError('permission_denied', 'revoked'));
    await expect(desktop.keyboardAction({ action: 'press', key: 'Enter' })).rejects.toMatchObject({ reason: 'permission_denied' });
    await expect(desktop.keyboardAction({ action: 'type', text: 'next' })).resolves.toMatchObject({ delivery: 'foreground' });
  });

  it('refuses unsupported or background actions without sending any native input', async () => {
    const { desktop, client } = await fixture();
    for (const request of [
      { action: 'drag', to: { x: 1, y: 1 } }, { action: 'down' }, { action: 'click', button: 'back' },
      { action: 'scroll', dy: 1, unit: 'pixel' }, { action: 'click', modifiers: ['cmd'] },
    ] satisfies PointerRequest[]) await expect(desktop.pointerAction(request)).rejects.toMatchObject({ reason: 'feature_unsupported' });
    await expect(desktop.pointerAction({ action: 'click', delivery: 'background' })).rejects.toMatchObject({ reason: 'would_require_activation' });
    await expect(desktop.keyboardAction({ action: 'down', key: 'Shift' })).rejects.toMatchObject({ reason: 'feature_unsupported' });
    await expect(desktop.ctl().windows.close(42)).rejects.toMatchObject({ reason: 'feature_unsupported' });
    await expect(desktop.launchApp('echo', ['no'], { CUSTOM: 'value' }, '/tmp')).rejects.toMatchObject({ reason: 'feature_unsupported' });
    await expect(desktop.open('https://example.com')).rejects.toMatchObject({ reason: 'feature_unsupported' });
    expect(client.click).not.toHaveBeenCalled();
    expect(client.move).not.toHaveBeenCalled();
    expect(client.scroll).not.toHaveBeenCalled();
    expect(client.press).not.toHaveBeenCalled();
  });

  it('retains permission diagnostics after capture refusal and never marks VNC available', async () => {
    const { desktop, client } = await fixture();
    client.permissions.mockResolvedValue({ accessibility: false, screenRecording: false });
    client.capture.mockRejectedValue(new ApiError('permission_denied', 'Screen Recording revoked'));
    await expect(desktop.screenshot()).rejects.toMatchObject({ reason: 'permission_denied' });
    const status = desktop.status();
    expect(status.features.screenshot.available).toBe(false);
    expect(status.features.input.available).toBe(false);
    expect(status.features.vnc.available).toBe(false);
    expect(status.display.error).toContain('Screen Recording');
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('rejects denied Accessibility permission before dispatching native input', async () => {
    const { desktop, client } = await fixture();
    client.permissions.mockResolvedValue({ accessibility: false, screenRecording: true });
    await expect(desktop.pointerAction({ action: 'click', x: 10, y: 10 })).rejects.toMatchObject({ reason: 'permission_denied' });
    await expect(desktop.keyboardAction({ action: 'type', text: 'must not be sent' })).rejects.toMatchObject({ reason: 'permission_denied' });
    expect(client.click).not.toHaveBeenCalled();
    expect(client.type).not.toHaveBeenCalled();
    expect(desktop.status().features.input.available).toBe(false);
    expect(desktop.status().display.error).toContain('Accessibility');
  });

  it('keeps diagnostics available when native startup fails', async () => {
    const { client } = await fixture();
    client.start.mockRejectedValue(new ApiError('feature_unsupported', 'signed helper missing'));
    const desktop = new MacDesktop(log, client);
    desktops.push(desktop);
    await expect(desktop.start()).resolves.toBeUndefined();
    expect(desktop.status().display).toMatchObject({ connected: false, error: 'signed helper missing' });
    expect(desktop.status().features.screenshot.available).toBe(false);
  });

  it('tracks native window epochs and rejects reused identities', async () => {
    const { desktop, client, window } = await fixture();
    expect((await desktop.ctl().windows.list())[0]).toMatchObject({ id: '0x2a', epoch: 0 });
    client.windows.mockResolvedValueOnce([]);
    expect(await desktop.ctl().windows.list()).toEqual([]);
    await expect(desktop.ctl().windows.resolve('42', 0)).rejects.toMatchObject({ reason: 'stale_handle' });
    window.pid = 101;
    await expect(desktop.ctl().windows.resolve('0x2a', 1)).rejects.toMatchObject({ reason: 'stale_handle' });
    expect(macWindowId(42n)).toBe(42);
    expect(() => macWindowId(2n ** 40n)).toThrow();
  });

  it('supports text clipboard with local generation and refuses image requests before mutation', async () => {
    const { desktop, client } = await fixture();
    await expect(desktop.ctl().clipboard.write({ text: 'value' })).resolves.toBe(1);
    await expect(desktop.ctl().clipboard.read()).resolves.toEqual({ text: 'hello', generation: 1 });
    await expect(desktop.ctl().clipboard.write({ text: 'value', image_png_base64: 'data' })).rejects.toMatchObject({ reason: 'feature_unsupported' });
    expect(client.clipboardWrite).toHaveBeenCalledTimes(1);
  });
});

describe('macOS AX snapshot integrity', () => {
  it('enforces max_depth=0 locally when the native driver returns depth-one children', async () => {
    const { desktop, client } = await fixture();
    const a11y = new MacA11y('auto', log, desktop);
    const tree = await a11y.tree({ window: '42', max_depth: 0 });
    expect(tree.truncated).toBe(true);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]).toMatchObject({ depth: 0, role: 'window', parent_id: null });
    await expect(a11y.act(tree.snapshot_id, `${tree.snapshot_id}.2a.2`, 'press')).rejects.toMatchObject({ reason: 'target_unavailable' });
    expect(client.pressElement).not.toHaveBeenCalled();
  });

  it('maps native roles, parents and logical bounds without Retina rescaling', async () => {
    const { desktop } = await fixture();
    const a11y = new MacA11y('auto', log, desktop);
    const tree = await a11y.tree({ window: '0x2a' });
    expect(tree.nodes[1]).toMatchObject({ role: 'button', native_role: 'AXButton', name: 'Save', parent_id: tree.nodes[0].element_id,
      bounds: { x: 12, y: 10, width: 20, height: 10 }, actions: ['press'], states: ['enabled'] });
    const found = await a11y.find({ role: 'button', name_contains: 'av', states: ['enabled'], window: '42' });
    expect(found.total).toBe(1);
  });

  it('passes exact native snapshot, token, pid and window and invalidates after action', async () => {
    const { desktop, client } = await fixture();
    const a11y = new MacA11y('auto', log, desktop);
    const tree = await a11y.tree({ window: '42' });
    await a11y.act(tree.snapshot_id, tree.nodes[1].element_id, 'press');
    expect(client.pressElement).toHaveBeenCalledWith(100, 42n, 'exact-token', 'native1');
    await expect(a11y.act(tree.snapshot_id, tree.nodes[1].element_id, 'press')).rejects.toMatchObject({ reason: 'stale_snapshot' });
    expect(client.click).not.toHaveBeenCalled();
  });

  it('refuses superseded snapshots, wrong element/snapshot pairs, and changed owning process', async () => {
    const { desktop, client, state, window } = await fixture();
    const a11y = new MacA11y('auto', log, desktop);
    const first = await a11y.tree({ window: '42' });
    state.snapshotId = 'native2';
    const second = await a11y.tree({ window: '42' });
    await expect(a11y.act(first.snapshot_id, first.nodes[1].element_id, 'press')).rejects.toMatchObject({ reason: 'stale_snapshot' });
    await expect(a11y.act(second.snapshot_id, first.nodes[1].element_id, 'press')).rejects.toMatchObject({ reason: 'target_unavailable' });
    window.pid = 101;
    await expect(a11y.act(second.snapshot_id, second.nodes[1].element_id, 'press')).rejects.toMatchObject({ reason: 'stale_snapshot' });
    expect(client.pressElement).not.toHaveBeenCalled();
  });

  it('propagates permission refusal and unsupported AX actions without a coordinate fallback', async () => {
    const { desktop, client } = await fixture();
    const a11y = new MacA11y('auto', log, desktop);
    const tree = await a11y.tree({ window: '42' });
    await expect(a11y.act(tree.snapshot_id, tree.nodes[1].element_id, 'set_value', 'abc')).rejects.toMatchObject({ reason: 'feature_unsupported' });
    client.pressElement.mockRejectedValue(new ApiError('permission_denied', 'AX denied'));
    await expect(a11y.act(tree.snapshot_id, tree.nodes[1].element_id, 'press')).rejects.toMatchObject({ reason: 'permission_denied' });
    expect(client.click).not.toHaveBeenCalled();
    expect(client.move).not.toHaveBeenCalled();
    client.permissions.mockResolvedValue({ accessibility: false, screenRecording: true });
    expect((await a11y.capability()).available).toBe(false);
    await expect(a11y.tree()).rejects.toMatchObject({ reason: 'permission_denied' });
  });
});
