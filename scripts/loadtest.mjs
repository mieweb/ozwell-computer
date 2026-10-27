#!/usr/bin/env node
// Real-world load test against the compose dev container, sampling /api/v1/metrics.
//
//   npm run loadtest                              typical: 1 human (Chromium noVNC) + 1 MCP agent, 15 min
//   npm run loadtest -- --profile stress          + 4 raw VNC viewers and 2 more agents
//   npm run loadtest -- --duration 60m --interval 2s
//   npm run loadtest -- --workload ehr          agent works in WebChart (needs OZ_WEBCHART_USER/PASS)
//   OZ_URL=... OZ_TOKEN=... npm run loadtest      against another server (no compose)
//
// Phases: baseline (idle) → load → cooldown (idle). Writes results/loadtest-<time>.{json,csv}.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ROOT, isRunning, up, waitReady } from './compose.mjs';
import { ehrAgent, ehrConfig, ehrHuman } from './workloads/ehr.mjs';

// ---------------------------------------------------------------- options

const PROFILES = {
  typical: { browserViewers: 1, rawViewers: 0, agents: 1 },
  stress: { browserViewers: 1, rawViewers: 4, agents: 3 },
};
const dur = (s) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s));
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
};
const WORKLOADS = ['basic', 'ehr'];
const opts = { workload: 'basic', profile: 'typical', duration: '15m', baseline: '30s', cooldown: '60s', interval: '1s', out: join(ROOT, 'results'), thinkMs: 2000 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const [k, v] = argv[i].replace(/^--/, '').split('=');
  if (k === 'help' || k === 'h') {
    process.stdout.write('options: --workload basic|ehr --profile typical|stress --duration 15m --baseline 30s --cooldown 60s --interval 1s --think-ms 2000 --out results/\n');
    process.exit(0);
  }
  const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!(key in opts)) throw new Error(`unknown option --${k}`);
  opts[key] = v ?? argv[++i];
}
const profile = PROFILES[opts.profile];
if (!profile) throw new Error(`unknown profile ${opts.profile}`);
if (!WORKLOADS.includes(opts.workload)) throw new Error(`unknown workload ${opts.workload}`);
if (opts.workload === 'ehr') ehrConfig(); // fail fast on missing credentials
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.5 + Math.random());
const log = (m) => process.stderr.write(`[loadtest ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

// ---------------------------------------------------------------- target

let URL_, TOKEN;
if (process.env.OZ_URL) {
  URL_ = process.env.OZ_URL; TOKEN = process.env.OZ_TOKEN ?? '';
} else {
  if (!isRunning()) { log('starting compose service'); up(); }
  ({ url: URL_, token: TOKEN } = await waitReady());
}
const auth = { authorization: `Bearer ${TOKEN}` };
const api = async (method, path, body) => {
  const r = await fetch(URL_ + path, {
    method, headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') ?? '';
  return ct.includes('json') ? r.json() : r.text();
};

// ---------------------------------------------------------------- metrics sampling

/** Parse the Prometheus text format into [{name, labels, value}]. */
function parseProm(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels = {};
    if (m[2]) for (const l of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}

const samples = [];
let phase = 'baseline';
const t0 = Date.now();
async function sample() {
  const text = await (await fetch(`${URL_}/api/v1/metrics`, { headers: auth })).text();
  const s = { t: (Date.now() - t0) / 1000, phase };
  for (const e of parseProm(text)) {
    const { name, labels, value } = e;
    if (name === 'ozwell_cgroup_memory_bytes') s[labels.scope === 'container' ? 'container' : `unit:${labels.unit}`] = value;
    else if (name === 'ozwell_cgroup_memory_peak_bytes' && labels.scope === 'container') s.containerPeak = value;
    else if (name === 'ozwell_process_pss_bytes') s[`cmd:${labels.command}`] = value;
    else if (name === 'ozwell_cgroup_memory_stat_bytes') s[`stat:${labels.type}`] = value;
    else if (name === 'process_resident_memory_bytes') s.nodeRss = value;
    else if (name === 'nodejs_heap_size_used_bytes') s.nodeHeapUsed = value;
    else if (name === 'nodejs_external_memory_bytes') s.nodeExternal = value;
    else if (name === 'nodejs_eventloop_lag_p99_seconds') s.eventLoopP99 = value;
    else if (name === 'ozwell_vnc_sessions') s.vncSessions = value;
    else if (name === 'ozwell_vnc_sent_bytes_total') s.vncBytes = value;
    else if (name === 'ozwell_vnc_updates_total') s.vncUpdates = value;
    else if (name === 'ozwell_mcp_sessions') s.mcpSessions = value;
  }
  samples.push(s);
  return s;
}

// ---------------------------------------------------------------- workload pieces

const stop = { flag: false };
const latencies = {}; // name -> ms[]
async function timed(name, fn) {
  const t = performance.now();
  try { return await fn(); } finally { (latencies[name] ??= []).push(performance.now() - t); }
}
const errors = {};
const steps = {}; // completed workload steps by name
const mark = (name) => { steps[name] = (steps[name] ?? 0) + 1; };
const countError = (where, e) => { errors[where] = (errors[where] ?? 0) + 1; if (errors[where] <= 3) log(`${where}: ${e?.message ?? e}`); };

const ANIM_PAGE = `<!doctype html><title>oz-load</title><body style="margin:0;background:#111;color:#eee;font:14px sans-serif">
<canvas id=c width=900 height=500></canvas><div id=t style="height:200px;overflow:hidden"></div><script>
const c=document.getElementById('c'),x=c.getContext('2d');let f=0;
(function d(){f++;x.fillStyle='rgba(17,17,17,.2)';x.fillRect(0,0,900,500);for(let i=0;i<30;i++){x.fillStyle='hsl('+((f*3+i*12)%360)+',80%,60%)';
x.beginPath();x.arc(450+Math.cos(f/30+i)*300,250+Math.sin(f/20+i*2)*180,12,0,7);x.fill();}requestAnimationFrame(d)})();
const t=document.getElementById('t');setInterval(()=>{t.insertAdjacentHTML('afterbegin','<div>'+new Date().toISOString()+' '+Math.random().toString(36)+'</div>');while(t.children.length>40)t.lastChild.remove()},100);
</script>`;

async function setupDesktop() {
  await fetch(`${URL_}/api/v1/fs/content?path=/tmp/oz-load.html`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: ANIM_PAGE });
  await api('POST', '/api/v1/apps/launch', { command: 'xfce4-terminal', args: ['--disable-server', '--title=oz-load-human', '--geometry=100x28+60+60'] });
}

/** A person in a real browser: watches, moves the mouse, types in a terminal, copies and pastes. */
async function human(browser, i) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  await page.goto(`${URL_}/?token=${encodeURIComponent(TOKEN)}`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'connected', null, { timeout: 30000 });
  const canvas = page.locator('#screen canvas');
  const box = await canvas.boundingBox();
  const toPage = (fx, fy) => [box.x + fx * box.width, box.y + fy * box.height];
  const terminal = async () => (await api('GET', '/api/v1/windows')).windows.find((w) => w.title === 'oz-load-human');
  const caps = await api('GET', '/api/v1/capabilities');
  if (opts.workload === 'ehr') { await ehrHuman(page, toPage, stop, countError, i); await ctx.close(); return; }
  let n = 0;
  while (!stop.flag) {
    try {
      n++;
      // wander
      for (let k = 0; k < 5; k++) await page.mouse.move(...toPage(Math.random(), Math.random()), { steps: 8 });
      const w = await terminal();
      if (w && n % 2 === 0) {
        const [px, py] = toPage((w.bounds.x + 200) / caps.display.width, (w.bounds.y + 100) / caps.display.height);
        await page.mouse.click(px, py);
        await page.keyboard.type(`ls -la /usr/share | tail -n 20  # human ${i} step ${n}`, { delay: 15 });
        await page.keyboard.press('Enter');
      }
      if (n % 6 === 0) { // copy/paste through the local clipboard
        await page.evaluate((t) => navigator.clipboard.writeText(t), `pasted by human ${i} at ${n}`);
        await page.keyboard.press('Control+Shift+V');
        await page.keyboard.press('Control+a');
      }
    } catch (e) { countError(`human${i}`, e); }
    await sleep(jitter(3500));
  }
  await ctx.close();
}

/** An MCP agent: screenshot → act → screenshot, with occasional UI-tree reads and commands. */
async function agent(i) {
  const client = new Client({ name: `loadtest-agent-${i}`, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: auth } });
  await client.connect(transport);
  const call = (name, args = {}) => timed(`mcp.${name}`, async () => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r;
  });
  if (opts.workload === 'ehr') {
    try {
      await ehrAgent({ call, stop, countError, think: () => sleep(jitter(Number(opts.thinkMs))), log, mark }, i);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
    return;
  }
  const title = `oz-load-agent-${i}`;
  await call('launch_app', { command: 'xfce4-terminal', args: ['--disable-server', `--title=${title}`, `--geometry=90x24+${700 + i * 60}+${120 + i * 60}`] });
  if (i === 0) await call('launch_app', { command: 'firefox-esr', args: ['--new-window', 'file:///tmp/oz-load.html'] });
  await sleep(3000);
  let n = 0;
  while (!stop.flag) {
    n++;
    try {
      const shot = await call('screenshot', { max_dimension: 1280 });
      const meta = JSON.parse(shot.content.find((c) => c.type === 'text').text);
      const wins = JSON.parse((await call('list_windows')).content[0].text).windows;
      const mine = wins.find((w) => w.title === title);
      if (mine) {
        const s = meta.width / meta.native_width;
        await call('click', { x: (mine.bounds.x + 80) * s, y: (mine.bounds.y + 60) * s, screenshot_id: meta.screenshot_id });
        await call('type_text', { text: `echo agent ${i} step ${n}; date` });
        await call('press_key', { key: 'Enter' });
      }
      if (n % 5 === 0 && mine) await call('get_ui_tree', { window: mine.id, max_nodes: 800 }).catch((e) => countError(`agent${i}.a11y`, e));
      if (n % 20 === 0) await call('run_command', { command: 'ls -R /usr/share | wc -l' });
    } catch (e) { countError(`agent${i}`, e); }
    await sleep(jitter(Number(opts.thinkMs)));
  }
  await transport.terminateSession().catch(() => undefined);
  await client.close().catch(() => undefined);
}

/** A raw VNC client that requests updates as fast as the server sends them. */
async function rawViewer(i) {
  const ws = new WebSocket(`${URL_.replace(/^http/, 'ws')}/websockify`, { headers: auth });
  let buf = Buffer.alloc(0), stage = 0;
  const send = (a) => ws.readyState === 1 && ws.send(Buffer.from(a));
  const req = (inc) => { const r = Buffer.alloc(10); r[0] = 3; r[1] = inc; r.writeUInt16BE(1920, 6); r.writeUInt16BE(1080, 8); send(r); };
  ws.on('message', (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0 && buf.length >= 12) { buf = buf.subarray(12); send(Buffer.from('RFB 003.008\n')); stage = 1; }
    if (stage === 1 && buf.length >= 2) { buf = buf.subarray(2); send([1]); stage = 2; }
    if (stage === 2 && buf.length >= 4) { buf = buf.subarray(4); send([1]); stage = 3; }
    if (stage === 3 && buf.length >= 24 && buf.length >= 24 + buf.readUInt32BE(20)) {
      buf = Buffer.alloc(0); stage = 4;
      const enc = Buffer.alloc(16); enc[0] = 2; enc.writeUInt16BE(3, 2); enc.writeInt32BE(16, 4); enc.writeInt32BE(-239, 8); enc.writeInt32BE(-223, 12); send(enc);
      req(0);
      return;
    }
    if (stage === 4) { buf = Buffer.alloc(0); req(1); } // coarse: any data → ask for the next update
  });
  ws.on('error', (e) => countError(`raw${i}`, e));
  while (!stop.flag) await sleep(500);
  ws.close();
}

// ---------------------------------------------------------------- run

const interval = dur(opts.interval);
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const t = Date.now();
    try { await sample(); } catch (e) { countError('sample', e); }
    await sleep(Math.max(0, interval - (Date.now() - t)));
  }
})();

const startWindows = new Set((await api('GET', '/api/v1/windows')).windows.map((w) => w.id));
log(`target ${URL_}; profile ${opts.profile} ${JSON.stringify(profile)}; baseline ${opts.baseline}, load ${opts.duration}, cooldown ${opts.cooldown}`);
await sleep(dur(opts.baseline));

phase = 'load';
log('load phase');
await setupDesktop();
const browser = profile.browserViewers ? await chromium.launch({ args: ['--no-sandbox'] }) : null;
const workers = [
  ...Array.from({ length: profile.browserViewers }, (_, i) => human(browser, i)),
  ...Array.from({ length: profile.agents }, (_, i) => agent(i)),
  ...Array.from({ length: profile.rawViewers }, (_, i) => rawViewer(i)),
].map((p) => p.catch((e) => countError('worker', e)));
const loadEnd = Date.now() + dur(opts.duration);
while (Date.now() < loadEnd) {
  await sleep(Math.min(60_000, loadEnd - Date.now()));
  const s = samples.at(-1);
  if (s) log(`t=${Math.round(s.t)}s container ${(s.container / 2 ** 20).toFixed(0)} MiB, node rss ${(s.nodeRss / 2 ** 20).toFixed(0)} MiB heap ${(s.nodeHeapUsed / 2 ** 20).toFixed(0)} MiB, vnc ${s.vncSessions} mcp ${s.mcpSessions}`);
}
stop.flag = true;
await Promise.all(workers);
await browser?.close();
// Close what the load created, so the cooldown shows what the server keeps.
for (const w of (await api('GET', '/api/v1/windows')).windows) if (!startWindows.has(w.id)) await api('POST', `/api/v1/windows/${w.id}/close`).catch(() => {});

phase = 'cooldown';
log('cooldown phase');
await sleep(dur(opts.cooldown));
sampling = false;
await sampler;

// ---------------------------------------------------------------- report

const MiB = (b) => (b === undefined ? null : Math.round((b / 2 ** 20) * 10) / 10);
const inPhase = (p) => samples.filter((s) => s.phase === p);
const max = (arr, k) => Math.max(...arr.map((s) => s[k] ?? 0));
const avg = (arr, k) => arr.reduce((a, s) => a + (s[k] ?? 0), 0) / Math.max(1, arr.length);
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null; };
const base = inPhase('baseline'), load = inPhase('load'), cool = inPhase('cooldown');
const keys = [...new Set(samples.flatMap(Object.keys))];

/** Growth of the 30 s rolling minimum of heap use during load, MiB/hour (GC noise removed). */
function heapTrend() {
  const mins = [];
  for (let i = 0; i < load.length; i += 30) {
    const w = load.slice(i, i + 30);
    if (w.length) mins.push([w[0].t, Math.min(...w.map((s) => s.nodeHeapUsed))]);
  }
  if (mins.length < 3) return null;
  const n = mins.length, mx = mins.reduce((a, p) => a + p[0], 0) / n, my = mins.reduce((a, p) => a + p[1], 0) / n;
  const slope = mins.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / mins.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return MiB(slope * 3600);
}
const vncRate = (() => {
  if (load.length < 2) return null;
  const a = load[0], b = load.at(-1), secs = b.t - a.t;
  return { updates_per_s: Math.round(((b.vncUpdates - a.vncUpdates) / secs) * 10) / 10, mib_per_s: MiB((b.vncBytes - a.vncBytes) / secs) };
})();

const top = (prefix) => keys.filter((k) => k.startsWith(prefix))
  .map((k) => [k.slice(prefix.length), MiB(max(load, k)), MiB(avg(base, k))])
  .filter(([, peak]) => peak > 1).sort((x, y) => y[1] - x[1]);

const summary = {
  workload: opts.workload, profile: opts.profile, ...profile, duration: opts.duration, target: URL_, samples: samples.length,
  container: {
    // anon = process memory (what leaks / OOM-kills); total also counts reclaimable page cache
    anon_baseline_mib: MiB(avg(base, 'stat:anon')), anon_peak_mib: MiB(max(load, 'stat:anon')), anon_after_cooldown_mib: MiB(avg(cool.slice(-10), 'stat:anon')),
    total_baseline_mib: MiB(avg(base, 'container')), total_peak_mib: MiB(max(load, 'container')), total_after_cooldown_mib: MiB(avg(cool.slice(-10), 'container')),
    cgroup_peak_mib_since_start: MiB(max(samples, 'containerPeak')),
  },
  server: {
    rss_baseline_mib: MiB(avg(base, 'nodeRss')), rss_peak_mib: MiB(max(load, 'nodeRss')), rss_after_cooldown_mib: MiB(avg(cool.slice(-10), 'nodeRss')),
    heap_baseline_mib: MiB(avg(base, 'nodeHeapUsed')), heap_peak_mib: MiB(max(load, 'nodeHeapUsed')), heap_after_cooldown_mib: MiB(avg(cool.slice(-10), 'nodeHeapUsed')),
    heap_trend_mib_per_hour: heapTrend(), event_loop_p99_peak_ms: Math.round(max(load, 'eventLoopP99') * 1000),
  },
  units_peak_mib: Object.fromEntries(top('unit:').map(([k, p]) => [k, p])),
  processes_peak_pss_mib: Object.fromEntries(top('cmd:').slice(0, 15).map(([k, p]) => [k, p])),
  vnc: vncRate,
  latency_ms: Object.fromEntries(Object.entries(latencies).map(([k, xs]) => [k, { n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)) }])),
  steps,
  errors,
};

mkdirSync(opts.out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base_ = join(opts.out, `loadtest-${opts.workload}-${opts.profile}-${stamp}`);
writeFileSync(`${base_}.json`, JSON.stringify({ options: opts, summary, samples }, null, 2));
writeFileSync(`${base_}.csv`, [keys.join(','), ...samples.map((s) => keys.map((k) => s[k] ?? '').join(','))].join('\n') + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
log(`wrote ${base_}.json and .csv`);
process.exit(0);
