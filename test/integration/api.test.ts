/**
 * Coverage for the HTTP API surface not exercised by e2e.test.ts. Each test checks a real
 * effect on the desktop, not just a status code.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { URL_, auth, api, exec, fileContent, freshXterm, regionShot, RfbClient, settledShot, sleep, waitFor, windows, zenity } from './helpers.js';

const win = async (id: string) => (await api('GET', `/api/v1/windows/${id}`)).body;

describe('system', () => {
  it('/displays reports the screen', async () => {
    const r = await api('GET', '/api/v1/displays');
    expect(r.status).toBe(200);
    const caps = (await api('GET', '/api/v1/capabilities')).body;
    expect(r.body.displays.length).toBeGreaterThan(0);
    expect(r.body.displays[0].bounds).toMatchObject({ width: caps.display.width, height: caps.display.height });
  });
});

describe('desktop theme', () => {
  const reset = () => exec('rm -f ~/.config/ozwell-computer/color-scheme');
  const effective = async () => (await exec('xfconf-query -c xsettings -p /Net/ThemeName; xfconf-query -c xfwm4 -p /general/theme; xfconf-query -c xfce4-panel -p /panels/dark-mode')).stdout.trim().split('\n');

  it('sets the GTK and xfwm4 themes once with if_unset, then only on explicit changes', async () => {
    await reset();
    expect((await api('GET', '/api/v1/desktop/theme')).body).toEqual({ scheme: 'light', set: false });
    expect((await api('PUT', '/api/v1/desktop/theme', { scheme: 'dark', if_unset: true })).body).toEqual({ scheme: 'dark', set: true });
    expect((await api('PUT', '/api/v1/desktop/theme', { scheme: 'light', if_unset: true })).body).toEqual({ scheme: 'dark', set: true });
    expect(await effective()).toEqual(['Adwaita-dark', 'Greybird-dark', 'true']);
    expect((await api('PUT', '/api/v1/desktop/theme', { scheme: 'light' })).body).toEqual({ scheme: 'light', set: true });
    expect((await api('GET', '/api/v1/desktop/theme')).body).toEqual({ scheme: 'light', set: true });
    expect(await effective()).toEqual(['Adwaita', 'Greybird', 'false']);
    expect((await api('PUT', '/api/v1/desktop/theme', { scheme: 'blue' })).status).toBe(400);
    await reset();
  });
});

describe('metrics', () => {
  it('/metrics serves Prometheus text with memory and session series', async () => {
    const res = await fetch(`${URL_}/api/v1/metrics`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    for (const name of ['process_resident_memory_bytes', 'nodejs_heap_size_used_bytes', 'ozwell_cgroup_memory_bytes', 'ozwell_process_resident_bytes', 'ozwell_process_pss_bytes', 'ozwell_cgroup_memory_stat_bytes{type="anon"}', 'ozwell_vnc_sessions', 'ozwell_mcp_sessions', 'ozwell_http_request_duration_seconds_bucket', 'ozwell_x_connected 1', 'ozwell_cgroup_cpu_seconds_total', 'ozwell_cpus']) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/ozwell_process_resident_bytes\{command="node"\} \d+/);
    expect(text).toMatch(/ozwell_cgroup_memory_bytes\{scope="container",unit=""\} \d+/);
    expect((await fetch(`${URL_}/api/v1/metrics`)).status).toBe(401);
  });
});

describe('container image', () => {
  it('grants the desktop user passwordless sudo, including from processes the server starts', async () => {
    const r = await exec('id -un; sudo -n id -un');
    expect(r.stdout).toBe('desktop\nroot\n');
  });
});

describe('updates', () => {
  it('reports versions, checks on demand, and runs an upgrade request to completion', async () => {
    const s = (await api('GET', '/api/v1/update')).body;
    // compose turns update checks off unless OZWELL_COMPUTER_UPDATE_URL is set (CI sets it).
    if (!s.supported) {
      expect(s.limitation).toBeTruthy();
      expect((await api('POST', '/api/v1/update/check')).status).toBe(200);
      expect((await api('POST', '/api/v1/update/apply')).status).toBe(501);
      return;
    }
    expect(s).toMatchObject({ supported: true, url: expect.any(String) });
    expect(s.current).toMatch(/^\d+\.\d+\.\d+/); // the installed .deb (or build, on the git channel)
    if (s.url.startsWith('git+')) expect(s.revision.current).toMatch(/^[0-9a-f]{40}$/);
    const c = await api('POST', '/api/v1/update/check');
    expect(c.status).toBe(200);
    expect(c.body.checked_at).toBeTruthy();
    expect(c.body.latest !== null || c.body.error !== null).toBe(true);

    const r = await api('POST', '/api/v1/update/apply');
    expect(r.status).toBe(202);
    expect(['requested', 'running']).toContain(r.body.upgrade.state);
    // The root upgrade unit picks the request up and finishes (no newer version here,
    // so "unchanged"; "failed" if apt can't reach a source). On the git channel a main
    // that moved since the image was built means a full build, hence the long wait.
    const done = await waitFor(async () => {
      // A git install stops the server for a while; keep polling through refused connections.
      const u = (await api('GET', '/api/v1/update').catch(() => null))?.body.upgrade;
      return u && ['unchanged', 'succeeded', 'failed'].includes(u.state) ? u : null;
    }, 600000);
    expect(done.log).toContain('installed: ');
  }, 630000);
});

describe('pointer actions', () => {
  it('drag moves a window by its title bar', async () => {
    const id = await freshXterm('oz-drag');
    const before = (await win(id)).bounds;
    const grab = { x: before.x + 60, y: before.y - 10 }; // title bar sits just above the client area
    const r = await api('POST', '/api/v1/input/pointer', { action: 'drag', ...grab, to: { x: grab.x + 200, y: grab.y + 100 }, duration_ms: 300 });
    expect(r.status).toBe(200);
    await sleep(300);
    const after = (await win(id)).bounds;
    expect(Math.abs(after.x - before.x - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(after.y - before.y - 100)).toBeLessThanOrEqual(3);
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('down / move / up performs a manual drag', async () => {
    const id = await freshXterm('oz-downup');
    const before = (await win(id)).bounds;
    const x = before.x + 60, y = before.y - 10;
    expect((await api('POST', '/api/v1/input/pointer', { action: 'down', x, y })).status).toBe(200);
    for (let i = 1; i <= 5; i++) await api('POST', '/api/v1/input/pointer', { action: 'move', x: x + i * 30, y });
    expect((await api('POST', '/api/v1/input/pointer', { action: 'up', x: x + 150, y })).status).toBe(200);
    await sleep(300);
    expect(Math.abs((await win(id)).bounds.x - before.x - 150)).toBeLessThanOrEqual(3);
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('scroll moves terminal scrollback', async () => {
    const id = await freshXterm('oz-scroll');
    await api('POST', '/api/v1/input/keyboard', { action: 'type', text: 'seq 1 300\n' });
    const b = (await win(id)).bounds;
    const region = [b.x, b.y, b.width, b.height] as const;
    const bottom = await settledShot(...region); // after seq has finished drawing
    // Poll rather than sleep: repaint timing varies with whatever else the desktop is doing.
    await api('POST', '/api/v1/input/pointer', { action: 'scroll', x: b.x + 100, y: b.y + 100, dy: -10 });
    await waitFor(async () => !(await regionShot(...region)).equals(bottom), 3000);
    // Scroll down well past the bottom (clamped there) so lost/coalesced wheel events can't matter.
    await api('POST', '/api/v1/input/pointer', { action: 'scroll', x: b.x + 100, y: b.y + 100, dy: 40 });
    await waitFor(async () => (await regionShot(...region)).equals(bottom), 5000);
    await api('POST', `/api/v1/windows/${id}/close`);
  });
});

describe('keyboard actions', () => {
  it('down / up hold a modifier across other keys', async () => {
    const id = await freshXterm('oz-keyhold');
    await exec('rm -f /tmp/oz-keyhold.txt');
    await api('POST', '/api/v1/input/keyboard', { action: 'type', text: 'echo ' });
    expect((await api('POST', '/api/v1/input/keyboard', { action: 'down', key: 'Shift' })).status).toBe(200);
    await api('POST', '/api/v1/input/keyboard', { action: 'press', key: 'KeyA' });
    await api('POST', '/api/v1/input/keyboard', { action: 'press', key: 'KeyB' });
    expect((await api('POST', '/api/v1/input/keyboard', { action: 'up', key: 'Shift' })).status).toBe(200);
    await api('POST', '/api/v1/input/keyboard', { action: 'type', text: 'c > /tmp/oz-keyhold.txt\n' });
    expect(await fileContent('/tmp/oz-keyhold.txt')).toBe('ABc\n');
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('type mode=paste goes through the clipboard and restores it', async () => {
    await api('PUT', '/api/v1/clipboard', { text: 'keep me' });
    await zenity(['--entry', '--text=paste'], '/tmp/oz-pastemode.txt', 'oz-pastemode');
    expect((await api('POST', '/api/v1/input/keyboard', { action: 'type', mode: 'paste', text: 'pasted ✓ mode' })).status).toBe(200);
    await api('POST', '/api/v1/input/keyboard', { action: 'press', key: 'Enter' });
    expect(await fileContent('/tmp/oz-pastemode.txt')).toBe('pasted ✓ mode\n');
    expect((await api('GET', '/api/v1/clipboard')).body.text).toBe('keep me');
  });
});

describe('window state', () => {
  it('minimize, restore and maximize', async () => {
    const id = await freshXterm('oz-state');
    expect((await api('POST', `/api/v1/windows/${id}/minimize`)).status).toBe(200);
    await waitFor(async () => (await win(id)).minimized);
    expect((await api('POST', `/api/v1/windows/${id}/restore`)).status).toBe(200);
    await waitFor(async () => !(await win(id)).minimized);
    expect((await api('POST', `/api/v1/windows/${id}/maximize`)).status).toBe(200);
    await waitFor(async () => (await win(id)).maximized);
    const caps = (await api('GET', '/api/v1/capabilities')).body;
    expect((await win(id)).bounds.width).toBeGreaterThan(caps.display.width - 20);
    expect((await api('POST', `/api/v1/windows/${id}/restore`)).status).toBe(200);
    await waitFor(async () => !(await win(id)).maximized);
    await api('POST', `/api/v1/windows/${id}/close`);
  });

  it('/open hands a folder to the file manager', async () => {
    await exec('mkdir -p /tmp/oz-open-dir');
    const r = await api('POST', '/api/v1/open', { target: '/tmp/oz-open-dir' });
    expect(r.status).toBe(200);
    const w = await waitFor(async () => (await windows()).find((x) => /oz-open-dir/.test(x.title)));
    expect(w.app).toMatch(/thunar/i);
    await api('POST', `/api/v1/windows/${w.id}/close`);
    expect((await api('POST', '/api/v1/open', { target: '--help' })).status).toBe(400);
  });
});

describe('accessibility tree', () => {
  it('scopes the tree to one window', async () => {
    const id = await zenity(['--question', '--text=tree'], '/tmp/oz-tree.txt', 'oz-tree');
    const r = await api('GET', `/api/v1/a11y/tree?window=${id}`);
    expect(r.status).toBe(200);
    expect(r.body.snapshot_id).toBeTruthy();
    const roles = (r.body.nodes as any[]).map((n) => `${n.role}:${n.name}`);
    expect(roles).toEqual(expect.arrayContaining(['button:Yes', 'button:No']));
    expect((r.body.nodes as any[]).every((n) => n.app === 'zenity')).toBe(true);
    await api('POST', `/api/v1/windows/${id}/close`);
  });
});

describe('screenshot', () => {
  it('ocr=true returns the text in the captured window', async () => {
    const id = await zenity(['--info', '--text=Ozwell OCR Probe'], '/tmp/oz-ocr.txt', 'oz-ocr');
    const r = await api('GET', `/api/v1/screenshot?window=${id}&ocr=true`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ format: 'png', image_base64: expect.any(String) });
    expect(r.body.text).toContain('Ozwell OCR Probe');
    expect((await api('GET', `/api/v1/screenshot?window=${id}`, undefined, { accept: 'application/json' })).body.text).toBeUndefined();
    await api('POST', `/api/v1/windows/${id}/close`);
  });
});

describe('exec and files', () => {
  it('streams NDJSON with ?stream=1', async () => {
    const res = await fetch(`${URL_}/api/v1/exec?stream=1`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'echo one; sleep 0.2; echo two >&2; exit 4' }),
    });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual(expect.arrayContaining([{ stream: 'stdout', data: 'one\n' }, { stream: 'stderr', data: 'two\n' }]));
    expect(lines.at(-1).exit).toMatchObject({ exit_code: 4, stdout: 'one\n', stderr: 'two\n' });
  });

  it('exec with wait_ms hands off long commands to /exec/jobs', async () => {
    const quick = await api('POST', '/api/v1/exec', { cmd: 'echo hi', wait_ms: 5000 });
    expect(quick.status).toBe(200);
    expect(quick.body).toMatchObject({ state: 'exited', exit_code: 0, stdout: 'hi\n' });
    const slow = await api('POST', '/api/v1/exec', { cmd: 'sleep', args: ['2'], wait_ms: 200 });
    expect(slow.status).toBe(202);
    expect(slow.body.state).toBe('running');
    const done = await api('GET', `/api/v1/exec/jobs/${slow.body.job_id}?wait_ms=10000`);
    expect(done.body).toMatchObject({ state: 'exited', exit_code: 0 });
    const streamed = await (await fetch(`${URL_}/api/v1/exec/jobs/${slow.body.job_id}/stream`, { headers: auth })).text();
    expect(streamed).toContain('event: state');
    expect(streamed.trimEnd()).toMatch(/event: end\ndata: \{.*"state":"exited".*\}$/);
    const long = await api('POST', '/api/v1/exec', { cmd: 'sleep 60', wait_ms: 0 });
    const listed = await api('GET', '/api/v1/exec/jobs');
    expect(listed.body.jobs[0]).toMatchObject({ job_id: long.body.job_id, state: 'running', command: 'sleep 60' });
    expect(listed.body.jobs.map((j: any) => j.job_id)).toContain(slow.body.job_id);
    expect((await api('DELETE', `/api/v1/exec/jobs/${long.body.job_id}`)).body.state).toBe('cancelled');
    expect((await api('GET', '/api/v1/exec/jobs/j-000000000000')).status).toBe(404);
  });

  it('carries a job\'s output on the shared event stream', async () => {
    const ctl = new AbortController();
    const res = await fetch(`${URL_}/api/v1/events`, { headers: auth, signal: ctl.signal });
    const reader = res.body!.getReader();
    let text = '';
    const until = async (re: RegExp) => {
      while (!re.test(text)) text += Buffer.from((await reader.read()).value!).toString();
      return re.exec(text)!;
    };
    const hello = JSON.parse((await until(/event: hello\ndata: (.*)\n/))[1]);
    expect(hello.build).toMatch(/^[\w-]{16}$/); // web/vite.config.ts build-id
    const streamId = hello.stream_id;
    const job = await api('POST', '/api/v1/exec', { cmd: 'echo one; sleep 0.5; echo two', wait_ms: 0 });
    const r = await api('PUT', `/api/v1/events/${streamId}/job`, { job_id: job.body.job_id, tag: 't' });
    expect(r.body).toEqual({ ok: true });
    const end = JSON.parse((await until(/event: job\.end\ndata: (.*)\n/))[1]);
    expect(end).toMatchObject({ job_id: job.body.job_id, state: 'exited', exit_code: 0, tag: 't' });
    const out = [...text.matchAll(/event: job\.output\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).stdout).join('');
    expect(out).toBe('one\ntwo\n');
    ctl.abort();
    expect((await api('PUT', '/api/v1/events/unknown/job', { job_id: null })).status).toBe(404);
  });

  it('mkdir, move and delete', async () => {
    await exec('rm -rf /tmp/oz-fs');
    expect((await api('POST', '/api/v1/fs/mkdir', { path: '/tmp/oz-fs/a/b' })).status).toBe(200);
    await exec('echo hi > /tmp/oz-fs/a/b/f.txt');
    expect((await api('POST', '/api/v1/fs/move', { from: '/tmp/oz-fs/a/b/f.txt', to: '/tmp/oz-fs/c/g.txt' })).status).toBe(200);
    expect((await exec('cat /tmp/oz-fs/c/g.txt; test -e /tmp/oz-fs/a/b/f.txt || echo gone')).stdout).toBe('hi\ngone\n');
    expect((await api('DELETE', '/api/v1/fs?path=/tmp/oz-fs/c/g.txt')).status).toBe(200);
    expect((await api('DELETE', '/api/v1/fs?path=/tmp/oz-fs/a')).status).toBe(400); // a directory, not recursive
    expect((await api('DELETE', '/api/v1/fs?path=/tmp/oz-fs&recursive=1')).status).toBe(200);
    expect((await api('GET', '/api/v1/fs?path=/tmp/oz-fs')).body.error.reason).toBe('path_not_found');
  });

  it('signed PUT URLs upload without the token', async () => {
    const data = Buffer.from('signed upload ✓');
    const sha = createHash('sha256').update(data).digest('hex');
    const s = (await api('POST', '/api/v1/fs/sign', { path: '/tmp/oz-signed.bin', method: 'PUT', ttl_s: 30 })).body;
    expect((await fetch(URL_ + s.url + `&sha256=${sha}`, { method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(200);
    expect((await exec('cat /tmp/oz-signed.bin')).stdout).toBe(data.toString());
    // a PUT signature is not valid for GET
    expect((await fetch(URL_ + s.url)).status).toBe(403);
  });
});

describe('presence', () => {
  it('join, cursor and leave', async () => {
    const j = await api('POST', '/api/v1/presence/join', { name: 'oz-presence', kind: 'human', color: '#123456' });
    expect(j.status).toBe(200);
    const id = j.body.participant_id;
    expect(j.body.roster.some((p: any) => p.participant_id === id && p.color === '#123456')).toBe(true);
    expect((await api('POST', '/api/v1/presence/cursor', { participant_id: id, x: 0.25, y: 0.75 })).status).toBe(200);
    const me = ((await api('GET', '/api/v1/presence')).body.roster as any[]).find((p) => p.participant_id === id);
    expect(me.cursor).toEqual({ x: 0.25, y: 0.75, visible: true });
    expect((await api('POST', '/api/v1/presence/leave', { participant_id: id })).body.ok).toBe(true);
    expect(((await api('GET', '/api/v1/presence')).body.roster as any[]).some((p) => p.participant_id === id)).toBe(false);
    expect((await api('POST', '/api/v1/presence/cursor', { participant_id: id, x: 0, y: 0 })).status).toBe(404);
  });
});

describe('view-only VNC', () => {
  it('ignores pointer and key input', async () => {
    await api('POST', '/api/v1/input/pointer', { action: 'move', x: 400, y: 400 });
    const c = new RfbClient(URL_.replace(/^http/, 'ws') + '/websockify?view_only=1', auth);
    await c.open();
    await c.handshake();
    const ptr = Buffer.alloc(6); ptr[0] = 5; ptr[1] = 1; ptr.writeUInt16BE(77, 2); ptr.writeUInt16BE(77, 4);
    c.send(ptr);
    await sleep(500);
    expect((await api('GET', '/api/v1/cursor')).body).toMatchObject({ x: 400, y: 400 });
    c.close();
  });
});

