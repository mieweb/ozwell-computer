/**
 * Every MCP tool not already exercised by the end-to-end agent test in e2e.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URL_, auth, api, exec, fileContent, freshXterm, regionShot, settledShot, sleep, waitFor, zenity } from './helpers.js';

let client: Client;
let transport: StreamableHTTPClientTransport;

/** Call a tool; returns parsed JSON of its first text block (or the raw text). */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  const text = r.content.find((c: any) => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}

beforeAll(async () => {
  await connect();
});
afterAll(async () => {
  await transport?.terminateSession().catch(() => undefined);
  await client?.close();
});

async function connect() {
  client = new Client({ name: 'oz-mcp-tools', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: auth } });
  await client.connect(transport);
}

const bounds = async (id: string) => (await api('GET', `/api/v1/windows/${id}`)).body.bounds;

describe('MCP tools', () => {
  it('exposes the full tool set', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'activate_window', 'click', 'command_output', 'double_click', 'drag', 'find_element', 'get_clipboard', 'get_ui_tree', 'hotkey',
      'launch_app', 'list_windows', 'move', 'press_key', 'read_file', 'run_command', 'screenshot', 'scroll',
      'set_clipboard', 'type_text', 'ui_action', 'update_computer', 'write_file',
    ]);
  });

  it('update_computer installs an announced update, or says why it cannot', async () => {
    const s = (await api('GET', '/api/v1/update')).body;
    const r: any = await client.callTool({ name: 'update_computer', arguments: {} });
    const body = JSON.parse(r.content[0].text);
    // compose turns update checks off unless OZWELL_COMPUTER_UPDATE_URL is set (CI sets it).
    if (!s.supported) {
      expect(r.isError).toBe(true);
      expect(body.error.reason).toBe('feature_unsupported');
      return;
    }
    expect(r.isError).toBeFalsy();
    expect(body.upgrade).toBe(s.available || s.latest === null ? 'requested' : 'none');
    if (body.upgrade === 'none') return;
    // A real upgrade: wait for it like the REST test, then reconnect (a restart drops the session).
    await waitFor(async () => {
      const u = (await api('GET', '/api/v1/update').catch(() => null))?.body.upgrade;
      return u && ['unchanged', 'succeeded', 'failed'].includes(u.state) ? u : null;
    }, 600000);
    await waitFor(async () => (await fetch(URL_ + '/health').catch(() => null))?.status === 204, 120000);
    await client.close();
    await connect();
  }, 750000);

  it('move puts the pointer where asked', async () => {
    const r = await tool('move', { x: 321, y: 123 });
    expect(r.cursor).toEqual({ x: 321, y: 123 });
    expect((await api('GET', '/api/v1/cursor')).body).toMatchObject({ x: 321, y: 123 });
  });

  it('double_click selects a word in a terminal', async () => {
    const id = await freshXterm('oz-mcp-dbl');
    // Put the word at a known cell: row 2, columns 10-18 (xterm's default font is 6x13 px).
    await tool('type_text', { text: "clear; printf '\\n\\n          zebraword\\n'\n" });
    await sleep(500);
    const b = await bounds(id);
    await tool('double_click', { x: b.x + 6 * 13 + 3, y: b.y + 13 * 2 + 6 });
    await sleep(300);
    expect((await exec('xclip -o -selection primary')).stdout).toBe('zebraword');
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('drag moves a window', async () => {
    const id = await freshXterm('oz-mcp-drag');
    const b = await bounds(id);
    await tool('drag', { x: b.x + 60, y: b.y - 10, to_x: b.x + 260, to_y: b.y + 90, duration_ms: 300 });
    await sleep(300);
    const a = await bounds(id);
    expect(Math.abs(a.x - b.x - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(a.y - b.y - 100)).toBeLessThanOrEqual(3);
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('scroll moves terminal scrollback', async () => {
    const id = await freshXterm('oz-mcp-scroll');
    await tool('type_text', { text: 'seq 1 300\n' });
    const b = await bounds(id);
    const before = await settledShot(b.x, b.y, b.width, b.height);
    await tool('scroll', { x: b.x + 100, y: b.y + 100, dy: -10 });
    await waitFor(async () => !(await regionShot(b.x, b.y, b.width, b.height)).equals(before), 3000);
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('get_ui_tree, find_element and ui_action drive a GTK dialog', async () => {
    const id = await zenity(['--entry', '--text=mcp'], '/tmp/oz-mcp-a11y.txt', 'oz-mcp-a11y');
    const tree = await tool('get_ui_tree', { window: id });
    expect(tree.nodes.some((n: any) => n.role === 'text_field')).toBe(true);
    const field = await tool('find_element', { role: 'text_field', window: id });
    expect(field.matches).toHaveLength(1);
    expect((await tool('ui_action', { snapshot_id: field.snapshot_id, element_id: field.matches[0].element_id, action: 'set_value', value: 'via mcp ✓' })).ok).toBe(true);
    const ok = await tool('find_element', { role: 'button', name: 'OK', window: id });
    expect((await tool('ui_action', { snapshot_id: ok.snapshot_id, element_id: ok.matches[0].element_id, action: 'press' })).ok).toBe(true);
    expect(await fileContent('/tmp/oz-mcp-a11y.txt')).toBe('via mcp ✓\n');
  });

  it('set_clipboard and get_clipboard round-trip through X', async () => {
    await tool('set_clipboard', { text: 'mcp clip ✓' });
    expect((await exec('xclip -o -selection clipboard')).stdout).toBe('mcp clip ✓');
    await exec("printf 'from x' | xclip -selection clipboard -i -loops 2 >/dev/null 2>&1 &");
    await sleep(500);
    expect((await tool('get_clipboard')).text).toBe('from x');
  });

  it('run_command waits, then hands off to command_output', async () => {
    const quick = await tool('run_command', { command: 'echo quick' });
    expect(quick).toMatchObject({ state: 'exited', exit_code: 0, stdout: 'quick\n' });
    const slow = await tool('run_command', { command: 'echo start; sleep 3; echo end', wait_ms: 500 });
    expect(slow).toMatchObject({ state: 'running', stdout: 'start\n', job_id: expect.stringMatching(/^j-/) });
    expect(slow.note).toContain('command_output');
    const done = await tool('command_output', { job_id: slow.job_id, stdout_offset: slow.stdout_offset, wait_ms: 10000 });
    expect(done).toMatchObject({ state: 'exited', exit_code: 0, stdout: 'end\n' });
    const long = await tool('run_command', { command: 'sleep 60', wait_ms: 0 });
    expect((await tool('command_output', { job_id: long.job_id, cancel: true })).state).toBe('cancelled');
  });

  it('screenshot with ocr adds the extracted text', async () => {
    const id = await zenity(['--info', '--text=Ozwell MCP Probe'], '/tmp/oz-mcp-ocr.txt', 'oz-mcp-ocr');
    const r: any = await client.callTool({ name: 'screenshot', arguments: { window: id, ocr: true } });
    expect(r.isError).toBeFalsy();
    expect(r.content.map((c: any) => c.type)).toEqual(['image', 'text', 'text']);
    expect(JSON.parse(r.content[1].text).screenshot_id).toBeTruthy();
    expect(r.content[2].text).toContain('Ozwell MCP Probe');
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('write_file and read_file round-trip', async () => {
    const w = await tool('write_file', { path: '/tmp/oz-mcp-dir/note.txt', content: 'hello ✓\nline 2\n' });
    expect(w).toMatchObject({ ok: true, path: '/tmp/oz-mcp-dir/note.txt' });
    expect(await tool('read_file', { path: '/tmp/oz-mcp-dir/note.txt' })).toBe('hello ✓\nline 2\n');
    const missing: any = await client.callTool({ name: 'read_file', arguments: { path: '/tmp/oz-mcp-dir/nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text).error.reason).toBe('path_not_found');
  });
});
