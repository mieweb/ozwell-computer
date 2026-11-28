#!/usr/bin/env node
// Read-only native smoke test. Never sends input, changes focus or reads/writes the clipboard.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const help = `Usage: node scripts/smoke-macos.mjs [options]
  --url <url>           Native Ozwell URL (or OZWELL_COMPUTER_URL; default http://127.0.0.1:8081)
  --token-file <path>   Read the access token from a file (or OZWELL_COMPUTER_TOKEN)
  --window <id>         Capture and inspect one window from /api/v1/windows
  --out <path>          Save the screenshot as PNG (optional)
  --require-a11y        Fail if accessibility is unavailable (otherwise report it as skipped)
  --help               Show this message

Checks health, native capabilities, displays, windows, PNG metadata, accessibility when
available, and MCP screenshot/window tools. Does not launch apps or send input.
`;

async function main() {
  const options = { url: process.env.OZWELL_COMPUTER_URL ?? 'http://127.0.0.1:8081', requireA11y: false };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--help') { console.log(help); return; }
    if (arg === '--require-a11y') { options.requireA11y = true; continue; }
    const key = { '--url': 'url', '--token-file': 'tokenFile', '--window': 'window', '--out': 'out' }[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[key] = value;
  }
  const base = new URL(options.url);
  assert(['http:', 'https:'].includes(base.protocol), 'URL must use HTTP or HTTPS');
  assert(!base.username && !base.password, 'Supply the token through the environment or --token-file');
  const token = (options.tokenFile ? await readFile(options.tokenFile, 'utf8') : process.env.OZWELL_COMPUTER_TOKEN ?? base.searchParams.get('token') ?? '').trim();
  assert(token, 'Set OZWELL_COMPUTER_TOKEN or pass --token-file');
  base.search = '';
  base.hash = '';
  base.pathname = '/';
  const headers = { authorization: `Bearer ${token}` };
  const request = async (path) => {
    const response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`${path.split('?')[0]} returned HTTP ${response.status}`);
    return response;
  };
  const capabilities = await (await request('/api/v1/capabilities')).json();
  assert.equal(capabilities.backend, 'macos', 'The server is not using --backend macos');
  assert.equal(capabilities.display.connected, true, 'The native display is not connected');
  for (const feature of ['screenshot', 'windows']) assert.equal(capabilities.features[feature].available, true, `${feature} is unavailable`);
  assert.equal(capabilities.features.vnc.available, false, 'The native pilot should report VNC unavailable');
  assert.equal((await request('/health')).status, 204, 'Health check did not return 204');
  const { displays } = await (await request('/api/v1/displays')).json();
  assert(Array.isArray(displays) && displays.some((display) => display.primary), 'No primary display was reported');
  const { windows } = await (await request('/api/v1/windows')).json();
  assert(Array.isArray(windows), 'Window list is invalid');
  if (options.window) assert(windows.some((window) => window.id === options.window), 'Requested window is absent; list windows again');
  const query = new URLSearchParams({ format: 'png', max_dimension: '1280' });
  if (options.window) query.set('window', options.window);
  const screenshot = await request(`/api/v1/screenshot?${query}`);
  assert.equal(screenshot.headers.get('content-type')?.split(';')[0], 'image/png', 'Screenshot is not a PNG');
  assert(screenshot.headers.get('x-screenshot-id'), 'Screenshot lacks a coordinate registry ID');
  const bytes = Buffer.from(await screenshot.arrayBuffer());
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Screenshot has no valid PNG header');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0 && Math.max(width, height) <= 1280, 'Screenshot dimensions are outside the requested limit');
  assert.equal(screenshot.headers.get('x-image-size'), `${width}x${height}`, 'Screenshot metadata does not match the PNG');
  assert(/^\d+x\d+$/.test(screenshot.headers.get('x-native-size') ?? ''), 'Screenshot has no native coordinate dimensions');
  const scale = Number(screenshot.headers.get('x-scale'));
  assert(Number.isFinite(scale) && scale > 0, 'Screenshot scale is invalid');
  if (options.out) {
    await mkdir(dirname(resolve(options.out)), { recursive: true });
    await writeFile(resolve(options.out), bytes);
  }
  let accessibility = { status: 'skipped', reason: capabilities.features.a11y?.limitation ?? 'Unavailable' };
  if (capabilities.features.a11y?.available) {
    const a11yQuery = new URLSearchParams({ max_depth: '3', max_nodes: '200' });
    if (options.window) a11yQuery.set('window', options.window);
    const tree = await (await request(`/api/v1/a11y/tree?${a11yQuery}`)).json();
    assert(typeof tree.snapshot_id === 'string' && tree.snapshot_id.length > 0 && Array.isArray(tree.nodes), 'Accessibility snapshot is invalid');
    accessibility = { status: 'passed', node_count: tree.nodes.length, truncated: tree.truncated };
  } else {
    assert(!options.requireA11y, `Accessibility is required: ${accessibility.reason}`);
  }
  const client = new Client({ name: 'ozwell-native-smoke', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers } });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ['screenshot', 'list_windows', 'get_ui_tree']) assert(names.includes(name), `MCP tool missing: ${name}`);
    const result = await client.callTool({ name: 'list_windows', arguments: {} });
    assert(!result.isError, 'MCP list_windows failed');
    const image = await client.callTool({ name: 'screenshot', arguments: { format: 'png', max_dimension: 1280, cursor: false, ...(options.window ? { window: options.window } : {}) } });
    assert(!image.isError && image.content.some((item) => item.type === 'image' && item.mimeType === 'image/png'), 'MCP screenshot failed');
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
  // Counts and dimensions are useful proof without printing window titles, UI text or the token.
  console.log(JSON.stringify({ server: base.origin, backend: capabilities.backend, display_count: displays.length, window_count: windows.length, screenshot: { width, height, native_size: screenshot.headers.get('x-native-size'), scale, ...(options.out ? { saved_to: resolve(options.out) } : {}) }, accessibility, mcp: 'passed', input: 'not tested', clipboard: 'not tested' }, null, 2));
}

main().catch((error) => { console.error(`Native smoke test failed: ${error.message}`); process.exitCode = 1; });
