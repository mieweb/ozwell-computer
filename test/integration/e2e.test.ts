/**
 * End-to-end tests against a throwaway ozwell-computer container (see global-setup.ts).
 *   npm test                       unit + integration
 *   OZ_URL=... OZ_TOKEN=... npm run test:integration   against an existing server
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { URL_, TOKEN, auth, sleep, api, exec, waitFor, freshXterm, RfbClient } from './helpers.js';

beforeAll(async () => {
  await waitFor(async () => (await fetch(URL_ + '/health')).status === 204, 30000);
});

describe('container smoke', () => {
  it('auth matrix', async () => {
    expect((await fetch(URL_ + '/api/v1/capabilities')).status).toBe(401);
    const q = await fetch(URL_ + '/?token=' + TOKEN, { redirect: 'manual' });
    expect(q.status).toBe(302);
    const cookie = q.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(URL_ + '/api/v1/capabilities', { headers: { cookie } })).status).toBe(200);
    expect((await fetch(URL_ + '/api/v1/capabilities', { headers: { 'x-auth-token': TOKEN } })).status).toBe(200);
    // The app shell is static and needs no credentials; the SPA gets its data from the API.
    const page = await fetch(URL_ + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toMatch(/<div id="root"/);
    expect(html).toMatch(/src="\/static\/assets\/[^"]+\.js"/);
  });

  it('capabilities report a working display', async () => {
    const c = (await api('GET', '/api/v1/capabilities')).body;
    expect(c.display.connected).toBe(true);
    expect(c.extensions).toEqual(expect.arrayContaining(['XTEST', 'DAMAGE', 'XFIXES']));
  });
});

describe('X11 core', () => {
  it('types into xterm and the shell runs it', async () => {
    await freshXterm('oz-type');
    await api('POST', '/api/v1/input/keyboard', { action: 'type', text: 'echo hi-$((6*7)) > /tmp/oz-type.txt' });
    await api('POST', '/api/v1/input/keyboard', { action: 'press', key: 'Enter' });
    const out = await waitFor(async () => (await exec('cat /tmp/oz-type.txt 2>/dev/null')).stdout);
    expect(out).toBe('hi-42\n');
    await api('POST', '/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'd'] });
  });

  it('types non-ASCII via spare keycodes', async () => {
    await freshXterm('oz-uni');
    await api('POST', '/api/v1/input/keyboard', { action: 'type', text: "printf '%s' 'é€ñ' > /tmp/oz-uni.txt" });
    await api('POST', '/api/v1/input/keyboard', { action: 'press', key: 'Enter' });
    expect(await waitFor(async () => (await exec('cat /tmp/oz-uni.txt 2>/dev/null')).stdout)).toBe('é€ñ');
    await api('POST', '/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'd'] });
  });

  it('screenshot-space clicks on a scaled image land within ±1px', async () => {
    const s = await api('GET', '/api/v1/screenshot?max_dimension=1280&format=jpeg');
    expect(s.headers.get('content-type')).toBe('image/jpeg');
    const id = s.headers.get('x-screenshot-id')!;
    const [nw] = s.headers.get('x-native-size')!.split('x').map(Number);
    const [iw] = s.headers.get('x-image-size')!.split('x').map(Number);
    const scale = nw / iw;
    for (const [x, y] of [[333, 111], [1000, 700], [0, 0]]) {
      const r = (await api('POST', '/api/v1/input/pointer', { action: 'move', x, y, screenshot_id: id })).body;
      expect(Math.abs(r.cursor.x - x * scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.cursor.y - y * scale)).toBeLessThanOrEqual(1);
    }
  });

  it('stale screenshot ids → 409 stale_geometry', async () => {
    const r = await api('POST', '/api/v1/input/pointer', { action: 'move', x: 1, y: 1, screenshot_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(r.status).toBe(409);
    expect(r.body.error.reason).toBe('stale_geometry');
  });

  it('window screenshot ids go stale when the window moves', async () => {
    const wid = await freshXterm('oz-move');
    const s = await api('GET', `/api/v1/screenshot?window=${wid}`);
    const id = s.headers.get('x-screenshot-id')!;
    expect((await api('POST', '/api/v1/input/pointer', { action: 'move', x: 5, y: 5, screenshot_id: id })).status).toBe(200);
    await api('PUT', `/api/v1/windows/${wid}/bounds`, { x: 400, y: 300 });
    await sleep(300);
    const r = await api('POST', '/api/v1/input/pointer', { action: 'move', x: 5, y: 5, screenshot_id: id });
    expect(r.body.error?.reason).toBe('stale_geometry');
    await api('POST', `/api/v1/windows/${wid}/close`);
  });

  it('JSON screenshot mode for agents', async () => {
    const r = await api('GET', '/api/v1/screenshot?max_dimension=320', undefined, { accept: 'application/json' });
    expect(r.body.screenshot_id).toBeTruthy();
    expect(Buffer.from(r.body.image_base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('background delivery is refused honestly', async () => {
    const r = await api('POST', '/api/v1/input/pointer', { action: 'click', x: 1, y: 1, delivery: 'background' });
    expect(r.status).toBe(422);
    expect(r.body.error.reason).toBe('would_require_activation');
  });
});

describe('clipboard', () => {
  it('API → another X client reads it', async () => {
    await api('PUT', '/api/v1/clipboard', { text: 'clip-from-api ✓' });
    expect((await exec('xclip -o -selection clipboard')).stdout).toBe('clip-from-api ✓');
  });

  it('another X client → API, with generation bump', async () => {
    const before = (await api('GET', '/api/v1/clipboard')).body.generation;
    await exec("printf 'from-xclip' | xclip -selection clipboard -i -loops 3 >/dev/null 2>&1 &");
    const c = await waitFor(async () => {
      const r = (await api('GET', '/api/v1/clipboard')).body;
      return r.text === 'from-xclip' ? r : null;
    });
    expect(c.generation).toBeGreaterThan(before);
  });

  it('PNG images round-trip', async () => {
    const png = (await api('GET', '/api/v1/screenshot?region=0,0,8,8')).body as Buffer;
    await api('PUT', '/api/v1/clipboard', { image_png_base64: png.toString('base64') });
    expect((await exec('xclip -o -selection clipboard -t TARGETS')).stdout).toContain('image/png');
    expect((await exec('xclip -o -selection clipboard -t image/png | wc -c')).stdout.trim()).toBe(String(png.length));
  });
});

describe('windows and events', () => {
  it('SSE delivers window.created and presence events', async () => {
    const ctl = new AbortController();
    const res = await fetch(URL_ + '/api/v1/events', { headers: auth, signal: ctl.signal });
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
        for (const m of buf.matchAll(/event: (\S+)/g)) seen.push(m[1]);
        buf = buf.slice(buf.lastIndexOf('\n'));
      }
    })().catch(() => undefined);
    await sleep(200);
    const wid = await freshXterm('oz-sse');
    await api('POST', '/api/v1/input/pointer', { action: 'move', x: 10, y: 10 }, { 'x-principal': JSON.stringify({ id: 'bot1', name: 'bot', kind: 'agent' }) });
    await waitFor(async () => seen.includes('window.created') && seen.includes('presence.cursor'));
    await api('POST', `/api/v1/windows/${wid}/close`);
    await waitFor(async () => seen.includes('window.destroyed'));
    ctl.abort();
    await pump;
  });
});

// ---------------------------------------------------------------- VNC

describe('VNC (RFB over WebSocket)', () => {
  let c: RfbClient;
  beforeAll(async () => {
    c = new RfbClient(URL_.replace(/^http/, 'ws') + '/websockify', auth);
    await c.open();
    await c.handshake();
  });
  afterAll(() => c?.close());

  it('rejects unauthenticated websocket upgrades', async () => {
    const ws = new WebSocket(URL_.replace(/^http/, 'ws') + '/websockify');
    const code = await new Promise((res) => { ws.on('unexpected-response', (_req, r) => res(r.statusCode)); ws.on('open', () => res(101)); });
    expect(code).toBe(401);
  });

  it('serves a full ZRLE frame plus cursor, then incremental damage', async () => {
    c.setEncodings([16, 0, -239, -223]);
    c.request(false);
    let rects = await c.update();
    expect(rects.some((r) => r.enc === 16 && r.w > 0)).toBe(true);
    // The ZRLE stream must inflate cleanly as one continuous zlib stream.
    const inflated = inflateSync(Buffer.concat(c.zrle), { finishFlush: 2 });
    expect(inflated.length).toBeGreaterThan(0);
    // Cause damage: open a window, then expect an incremental update covering part of the screen.
    c.request(true);
    const wid = await freshXterm('oz-vnc');
    rects = await c.update();
    expect(rects.length).toBeGreaterThan(0);
    await api('POST', `/api/v1/windows/${wid}/close`);
  });

  it('VNC pointer + key events drive the desktop', async () => {
    await freshXterm('oz-vnckeys');
    const ptr = Buffer.alloc(6); ptr[0] = 5; ptr[1] = 0; ptr.writeUInt16BE(250, 2); ptr.writeUInt16BE(200, 4);
    c.send(ptr);
    for (const ch of 'echo vnc > /tmp/oz-vnc.txt') {
      for (const down of [1, 0]) { const k = Buffer.alloc(8); k[0] = 4; k[1] = down; k.writeUInt32BE(ch.charCodeAt(0), 4); c.send(k); }
    }
    for (const down of [1, 0]) { const k = Buffer.alloc(8); k[0] = 4; k[1] = down; k.writeUInt32BE(0xff0d, 4); c.send(k); }
    expect(await waitFor(async () => (await exec('cat /tmp/oz-vnc.txt 2>/dev/null')).stdout)).toBe('vnc\n');
    const cur = (await api('GET', '/api/v1/cursor')).body;
    expect(cur).toMatchObject({ x: 250, y: 200 });
    await api('POST', '/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'd'] });
  });
});


// ---------------------------------------------------------------- MCP

describe('MCP', () => {
  it('agent opens xterm and runs uname -a; its cursor appears in presence', async () => {
    const client = new Client({ name: 'oz-it-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: auth } });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['screenshot', 'click', 'type_text', 'press_key', 'list_windows', 'run_command', 'get_ui_tree']));

    await client.callTool({ name: 'launch_app', arguments: { command: 'xterm', args: ['-xrm', 'XTerm*allowTitleOps: false', '-T', 'oz-mcp', '-geometry', '80x20+300+200'] } });
    const win = await waitFor(async () => {
      const r: any = await client.callTool({ name: 'list_windows', arguments: {} });
      return JSON.parse(r.content[0].text).windows.find((w: any) => w.title === 'oz-mcp');
    });
    await client.callTool({ name: 'activate_window', arguments: { window: win.id } });
    const shot: any = await client.callTool({ name: 'screenshot', arguments: { max_dimension: 960 } });
    expect(shot.content[0].type).toBe('image');
    const meta = JSON.parse(shot.content[1].text);
    // click in the middle of the xterm using screenshot coordinates
    const s = meta.width / meta.native_width;
    await client.callTool({ name: 'click', arguments: { x: (win.bounds.x + 50) * s, y: (win.bounds.y + 50) * s, screenshot_id: meta.screenshot_id } });
    await client.callTool({ name: 'type_text', arguments: { text: 'uname -a > /tmp/oz-mcp.txt' } });
    await client.callTool({ name: 'press_key', arguments: { key: 'Enter' } });
    const out = await waitFor(async () => {
      const r: any = await client.callTool({ name: 'run_command', arguments: { command: 'cat /tmp/oz-mcp.txt 2>/dev/null' } });
      return JSON.parse(r.content[0].text).stdout;
    });
    expect(out).toMatch(/^Linux /);

    const roster = (await api('GET', '/api/v1/presence')).body.roster as any[];
    const me = roster.find((p) => p.kind === 'agent' && p.name === 'oz-it-agent');
    expect(me?.cursor?.visible).toBe(true);

    const bad: any = await client.callTool({ name: 'click', arguments: { x: 1, y: 1, screenshot_id: 'nope' } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0].text).error.reason).toBe('stale_geometry');

    await client.callTool({ name: 'hotkey', arguments: { keys: ['ctrl', 'd'] } });
    await transport.terminateSession();
    await client.close();
    await sleep(200);
    expect(((await api('GET', '/api/v1/presence')).body.roster as any[]).some((p) => p.name === 'oz-it-agent')).toBe(false);
  });
});

// ---------------------------------------------------------------- a11y, files, pty

describe('accessibility', () => {
  it('finds and presses GTK buttons', async () => {
    await api('POST', '/api/v1/apps/launch', { command: 'sh', args: ['-c', 'zenity --entry --text=Name? > /tmp/oz-a11y.txt'] });
    const tf = await waitFor(async () => {
      const r = (await api('POST', '/api/v1/a11y/find', { role: 'text_field' })).body;
      return r.matches?.length ? r : null;
    });
    expect((await api('POST', '/api/v1/a11y/act', { snapshot_id: tf.snapshot_id, element_id: tf.matches[0].element_id, action: 'set_value', value: 'Grace' })).body.ok).toBe(true);
    const ok = (await api('POST', '/api/v1/a11y/find', { role: 'button', name: 'OK' })).body;
    const r = await api('POST', '/api/v1/a11y/act', { snapshot_id: ok.snapshot_id, element_id: ok.matches[0].element_id, action: 'press' });
    expect(r.body).toMatchObject({ ok: true, delivery: 'background' });
    expect(await waitFor(async () => (await exec('cat /tmp/oz-a11y.txt 2>/dev/null')).stdout)).toBe('Grace\n');
  });
});

describe('files and pty', () => {
  it('upload, range download, checksum, signed URL', async () => {
    const data = Buffer.from('0123456789abcdef');
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(data).digest('hex');
    let r = await fetch(URL_ + `/api/v1/fs/content?path=/tmp/oz-up.bin&sha256=${sha}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: data });
    expect(r.status).toBe(200);
    r = await fetch(URL_ + '/api/v1/fs/content?path=/tmp/oz-up.bin&sha256=00', { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: data });
    expect(r.status).toBe(422);
    r = await fetch(URL_ + '/api/v1/fs/content?path=/tmp/oz-up.bin', { headers: { ...auth, range: 'bytes=10-' } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe('abcdef');
    const signed = (await api('POST', '/api/v1/fs/sign', { path: '/tmp/oz-up.bin', ttl_s: 30 })).body;
    expect(await (await fetch(URL_ + signed.url)).text()).toBe(data.toString());
    expect((await fetch(URL_ + signed.url.replace('sig=', 'sig=x'))).status).toBe(403);
    expect((await api('GET', '/api/v1/fs?path=/tmp')).body.entries.some((e: any) => e.name === 'oz-up.bin')).toBe(true);
  });

  it('pty websocket', async () => {
    const ws = new WebSocket(URL_.replace(/^http/, 'ws') + '/api/v1/pty?cols=80&rows=24', { headers: auth });
    let out = '';
    ws.on('message', (d) => { out += d.toString(); });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ resize: [100, 30] }));
    ws.send('stty size; echo pty-$((1+1))\n');
    await waitFor(async () => out.includes('pty-2') && out.includes('30 100'));
    ws.close();
  });
});
