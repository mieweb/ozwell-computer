import pino from 'pino';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AccessibilityBackend, DesktopBackend, DesktopStatus } from '../../src/backend.js';
import { defaults } from '../../src/config.js';
import { ScreenshotRegistry } from '../../src/coords.js';
import { EventBus, Presence } from '../../src/presence/index.js';
import { buildServer } from '../../src/server.js';

const TOKEN = 'native-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

/** Deliberately has no `x` property: a native request must not reach into X11. */
function fakeNativeDesktop() {
  const bus = new EventBus();
  const registry = new ScreenshotRegistry();
  const presence = new Presence(bus);
  const bounds = { x: 0, y: 0, width: 32, height: 24 };
  const window = { id: '0x1', epoch: 0, title: 'Fixture', app: 'Fixture', app_instance: null, pid: 123, bounds, focused: null, minimized: false, maximized: null };
  const windows = {
    list: vi.fn(async () => [window]),
    resolve: vi.fn(async () => 1),
    info: vi.fn(async () => window),
    bounds: vi.fn(async () => bounds),
    setBounds: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const clipboard = {
    read: vi.fn(async () => ({ text: 'fixture clipboard', generation: 1 })),
    write: vi.fn(async () => 2),
  };
  const png = new PNG({ width: 16, height: 12 });
  png.data.fill(255);
  const image = PNG.sync.write(png);
  const inputResult = { delivery: 'foreground' as const, pointer_moved: true, focus_changed: null, cursor: { x: 2, y: 3 } };
  const status: DesktopStatus = {
    display: { name: 'macos:primary', connected: true, width: 32, height: 24, geometry_epoch: 0 },
    extensions: [],
    features: {
      screenshot: { available: true }, input: { available: true }, clipboard: { available: true }, windows: { available: true },
      damage: { available: false }, clipboard_events: { available: false }, background_delivery: { available: false },
      vnc: { available: false, limitation: 'Native macOS does not provide VNC in this pilot' },
    },
  };
  const desktop = {
    kind: 'macos' as const,
    displayName: 'macos:primary', bus, presence, registry,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => { presence.dispose(); }),
    status: vi.fn(() => status),
    ctl: () => ({ windows, clipboard }),
    displays: vi.fn(async () => [{ id: 'primary', name: 'Primary', primary: true, bounds, scale: 1 as const }]),
    screenshot: vi.fn(async () => ({
      data: image, contentType: 'image/png', format: 'png' as const,
      entry: registry.add({ origin: { x: 0, y: 0 }, scale: 2, imageSize: { width: 16, height: 12 }, nativeSize: { width: 32, height: 24 }, root: { width: 32, height: 24 }, geometryEpoch: 0 }),
    })),
    cursor: vi.fn(async () => ({ x: 2, y: 3, window: null })),
    pointerAction: vi.fn(async () => inputResult),
    keyboardAction: vi.fn(async () => ({ ...inputResult, pointer_moved: false })),
    launchApp: vi.fn(async () => ({ pid: 456 })),
    open: vi.fn(async () => ({ pid: 456 })),
  } satisfies DesktopBackend;
  const node = { element_id: 'e1', parent_id: null, depth: 0, role: 'button', native_role: 'AXButton', name: 'Fixture', value: null, description: '', bounds, states: ['enabled'], actions: ['press'] };
  const a11y = {
    capability: vi.fn(async () => ({ available: true, limitation: 'Fixture accessibility' })),
    tree: vi.fn(async () => ({ snapshot_id: 'native-snapshot', truncated: false, nodes: [node] })),
    find: vi.fn(async () => ({ snapshot_id: 'native-snapshot', truncated: false, matches: [node], total: 1 })),
    act: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => {}),
  } satisfies AccessibilityBackend;
  return { desktop, windows, clipboard, a11y, image };
}

describe('native backend server boundary', () => {
  let app: FastifyInstance;
  let base: string;
  const fake = fakeNativeDesktop();
  beforeAll(async () => {
    app = await buildServer({
      config: { ...defaults(), backend: 'macos', exec: false, strictResponses: true }, desktop: fake.desktop, a11y: fake.a11y,
      token: TOKEN, version: '0.0.0-test', ptyAvailable: false, updater: null, browser: null, log: pino({ level: 'silent' }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await app.close(); await fake.desktop.stop(); });

  it('reports native capabilities and health without an X11 session', async () => {
    expect((await app.inject('/health')).statusCode).toBe(204);
    expect((await app.inject('/api/v1/capabilities')).statusCode).toBe(401);
    const capabilities = (await app.inject({ url: '/api/v1/capabilities', headers: auth })).json();
    expect(capabilities).toMatchObject({
      backend: 'macos', display: { connected: true, name: 'macos:primary', width: 32, height: 24 }, extensions: [],
      features: { screenshot: { available: true }, a11y: { available: true }, exec: { available: false }, pty: { available: false }, vnc: { available: false } },
    });
    const displays = (await app.inject({ url: '/api/v1/displays', headers: auth })).json();
    expect(displays.displays[0]).toMatchObject({ id: 'primary', primary: true });
  });

  it('serves screenshot bytes and coordinate metadata from the backend', async () => {
    const response = await app.inject({ url: '/api/v1/screenshot?format=png&max_dimension=1280', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-image-size']).toBe('16x12');
    expect(response.headers['x-native-size']).toBe('32x24');
    expect(response.headers['x-scale']).toBe('2');
    expect(response.headers['x-screenshot-id']).toBeTruthy();
    expect(response.rawPayload).toEqual(fake.image);
    const json = (await app.inject({ url: '/api/v1/screenshot', headers: { ...auth, accept: 'application/json' } })).json();
    expect(json).toMatchObject({ format: 'png', width: 16, height: 12, native_width: 32, native_height: 24, scale: 2, image_base64: fake.image.toString('base64') });
  });

  it('refuses X11 desktop theme routes on macOS', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({ method, url: '/api/v1/desktop/theme', headers: auth,
        ...(method === 'PUT' ? { payload: { scheme: 'dark' } } : {}) });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ error: { reason: 'feature_unsupported', feature: 'theme' } });
    }
  });

  it('delegates window, clipboard and input routes to the native backend', async () => {
    expect((await app.inject({ url: '/api/v1/windows', headers: auth })).json().windows[0].id).toBe('0x1');
    expect((await app.inject({ url: '/api/v1/windows/0x1', headers: auth })).json().title).toBe('Fixture');
    expect((await app.inject({ url: '/api/v1/clipboard', headers: auth })).json().text).toBe('fixture clipboard');
    const pointer = { action: 'click', x: 2, y: 3, space: 'screen' };
    const response = await app.inject({ method: 'POST', url: '/api/v1/input/pointer', headers: { ...auth, 'x-principal': JSON.stringify({ id: 'test', name: 'Native test' }) }, payload: pointer });
    expect(response.statusCode).toBe(200);
    expect(response.json().focus_changed).toBeNull();
    expect(fake.desktop.pointerAction).toHaveBeenLastCalledWith(pointer, expect.objectContaining({ id: 'test', name: 'Native test' }));
    const keyboard = { action: 'type', text: 'fixture' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/input/keyboard', headers: auth, payload: keyboard })).statusCode).toBe(200);
    expect(fake.desktop.keyboardAction).toHaveBeenLastCalledWith(keyboard, null);
  });

  it('delegates native accessibility snapshots, search and actions', async () => {
    const tree = await app.inject({ url: '/api/v1/a11y/tree?window=0x1&max_depth=3&max_nodes=200', headers: auth });
    expect(tree.json()).toMatchObject({ snapshot_id: 'native-snapshot', nodes: [{ native_role: 'AXButton' }] });
    expect(fake.a11y.tree).toHaveBeenLastCalledWith({ window: '0x1', max_depth: 3, max_nodes: 200, hidden: false });
    expect((await app.inject({ method: 'POST', url: '/api/v1/a11y/find', headers: auth, payload: { role: 'button' } })).json().total).toBe(1);
    const action = await app.inject({ method: 'POST', url: '/api/v1/a11y/act', headers: auth, payload: { snapshot_id: 'native-snapshot', element_id: 'e1', action: 'press' } });
    expect(action.json()).toMatchObject({ ok: true });
    expect(fake.a11y.act).toHaveBeenLastCalledWith('native-snapshot', 'e1', 'press', undefined);
  });

  it('shows the native screenshot preview and refuses VNC explicitly', async () => {
    const page = await app.inject({ url: '/', headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('src="/static/native.js"');
    const preview = await app.inject({ url: '/static/native.js', headers: auth });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('/api/v1/screenshot');
    expect(page.body).not.toContain('src="/static/viewer.js"');
    const vnc = await app.inject({ url: '/websockify', headers: auth });
    expect(vnc.statusCode).toBe(501);
    expect(vnc.json()).toMatchObject({ error: { reason: 'feature_unsupported', feature: 'vnc' } });
  });

  it.each([
    ['POST', '/api/v1/exec', { cmd: 'id' }],
    ['POST', '/api/v1/apps/launch', { command: 'open' }],
    ['POST', '/api/v1/open', { target: '/tmp' }],
    ['GET', '/api/v1/fs?path=/tmp', undefined],
    ['GET', '/api/v1/fs/content?path=/tmp/fixture', undefined],
  ])('refuses %s %s when native execution is disabled', async (method, url, payload) => {
    const response = await app.inject({ method: method as 'GET' | 'POST', url, headers: auth, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.reason).toBe('permission_denied');
    expect(fake.desktop.launchApp).not.toHaveBeenCalled();
    expect(fake.desktop.open).not.toHaveBeenCalled();
  });

  it('uses the same native backend over MCP and omits execution tools', async () => {
    const client = new Client({ name: 'native-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: auth } });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ['screenshot', 'list_windows', 'get_ui_tree', 'find_element', 'ui_action', 'click']) expect(names).toContain(name);
      for (const name of ['run_command', 'command_output', 'read_file', 'write_file']) expect(names).not.toContain(name);
      const capture: any = await client.callTool({ name: 'screenshot', arguments: {} });
      expect(capture.isError).not.toBe(true);
      expect(fake.desktop.screenshot).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: false }));
      expect(capture.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: fake.image.toString('base64') });
      const windows: any = await client.callTool({ name: 'list_windows', arguments: {} });
      expect(JSON.parse(windows.content[0].text).windows[0].title).toBe('Fixture');
      const tree: any = await client.callTool({ name: 'get_ui_tree', arguments: { window: '0x1' } });
      expect(JSON.parse(tree.content[0].text)).toMatchObject({ snapshot_id: 'native-snapshot', nodes: [{ native_role: 'AXButton' }] });
      await client.callTool({ name: 'ui_action', arguments: { snapshot_id: 'native-snapshot', element_id: 'e1', action: 'press' } });
      expect(fake.a11y.act).toHaveBeenLastCalledWith('native-snapshot', 'e1', 'press', undefined);
      const launch: any = await client.callTool({ name: 'launch_app', arguments: { command: 'open' } });
      expect(launch.isError).toBe(true);
      expect(JSON.parse(launch.content[0].text).error.reason).toBe('permission_denied');
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  });

  it('runs the read-only smoke script against HTTP and MCP without input or clipboard access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ozwell-native-smoke-'));
    const output = join(directory, 'desktop.png');
    const before = {
      pointer: fake.desktop.pointerAction.mock.calls.length,
      keyboard: fake.desktop.keyboardAction.mock.calls.length,
      clipboardRead: fake.clipboard.read.mock.calls.length,
      clipboardWrite: fake.clipboard.write.mock.calls.length,
    };
    try {
      const result = await promisify(execFile)(process.execPath, ['scripts/smoke-macos.mjs', '--url', base, '--require-a11y', '--window', '0x1', '--out', output], {
        env: { ...process.env, OZWELL_COMPUTER_TOKEN: TOKEN }, timeout: 15_000,
      });
      const summary = JSON.parse(result.stdout);
      expect(summary).toMatchObject({ backend: 'macos', window_count: 1, screenshot: { width: 16, height: 12, native_size: '32x24', scale: 2, saved_to: output }, accessibility: { status: 'passed', node_count: 1 }, mcp: 'passed', input: 'not tested', clipboard: 'not tested' });
      expect(result.stdout).not.toContain(TOKEN);
      expect(result.stdout).not.toContain('Fixture');
      expect(await readFile(output)).toEqual(fake.image);
      expect(fake.desktop.pointerAction.mock.calls).toHaveLength(before.pointer);
      expect(fake.desktop.keyboardAction.mock.calls).toHaveLength(before.keyboard);
      expect(fake.clipboard.read.mock.calls).toHaveLength(before.clipboardRead);
      expect(fake.clipboard.write.mock.calls).toHaveLength(before.clipboardWrite);
      expect(fake.desktop.launchApp).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
