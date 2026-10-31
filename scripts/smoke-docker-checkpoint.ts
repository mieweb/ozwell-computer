#!/usr/bin/env node
// Actual Docker checkpoint provider + idle controller + HTTP/MCP gateway smoke.
// Run ONLY inside a disposable daemon lab with the matching /lab marker.
import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DockerCheckpointProvider } from '../orchestrator/src/providers/docker-checkpoint.ts';
import { DockerApi } from '../orchestrator/src/providers/docker.ts';
import type { Computer } from '../orchestrator/src/providers/types.ts';
import { IdleController } from '../orchestrator/src/lifecycle.ts';
import { InstanceClient } from '../orchestrator/src/instance-client.ts';
import { loadCatalog } from '../orchestrator/src/mcp.ts';
import { buildServer } from '../orchestrator/src/server.ts';

if (process.env.OZC_DOCKER_CHECKPOINT_LAB !== '1') throw new Error('This test requires an explicitly isolated disposable Docker checkpoint lab');
const socket = process.env.OZC_DOCKER_SOCKET ?? '/var/run/docker.sock';
if (!socket.startsWith('/') || socket.includes('\0')) throw new Error('Lab Docker socket must be an absolute path');
const engine = new DockerApi({ socketPath: socket }, 10_000);
const hostInfo = await engine.ok('GET', '/info');
const marker = JSON.parse(await readFile('/lab/.ozwell-checkpoint-lab', 'utf8'));
if (!hostInfo.ID || marker.daemonId !== hostInfo.ID) throw new Error('Disposable lab marker does not match this Docker daemon; refusing all mutations');
const sourceImage = process.env.OZC_CHECKPOINT_IMAGE;
if (!sourceImage) throw new Error('OZC_CHECKPOINT_IMAGE must name the native flat-v1 checkpoint image loaded into this disposable daemon');
const output = process.argv[2] ?? '/lab/output/results.json';
const idleMs = 1500;
const port = 18090;
const publicUrl = `http://{id}.desktop.test:${port}`;
const orchestratorUrl = `http://127.0.0.1:${port}`;
const psk = randomBytes(24).toString('base64url');
const env = { ...process.env, COMPUTER_GATEWAY_URL: publicUrl, DOCKER_CHECKPOINT_PUBLIC_URL: publicUrl, DOCKER_CHECKPOINT_LOCK_DIR: '/lab/checkpoint-locks' };
const uri = new URL('docker-checkpoint:///');
uri.pathname = socket;
uri.searchParams.set('image', sourceImage);
uri.searchParams.set('network', 'bridge');
uri.searchParams.set('publish', '1');
uri.searchParams.set('publish_host', '127.0.0.1');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const result: Record<string, any> = {
  started_at: new Date().toISOString(), passed: false, idle_ms: idleMs, daemon_id: hostInfo.ID, source_image: sourceImage,
  scope: 'Real native flat-v1 desktop, production DockerCheckpointProvider + IdleController + HTTP/WebSocket/MCP wake gateway on an isolated Docker daemon.',
  limitations: ['Controller restart is tested; host reboot, storage corruption and cross-host restore are not simulated.', 'A small network namespace anchor and the external control plane remain running while application PID/RAM must be zero.', 'CRIU recreates kernel tasks: process start_ticks may change although PID, RAM nonce/hash, GUI window and unsaved application state persist.'],
  cycles: [], checks: {},
};
const makeProvider = () => new DockerCheckpointProvider(uri, env);
let provider = makeProvider();
let controller!: IdleController;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let computer: Computer | undefined;
let mainId = '', anchorId = '';
let probe: any;
let initial: any;
let gui: any;
const aborters = new Set<AbortController>();
const sockets = new Set<Duplex>();
const secret = (s: unknown) => String(s).split(psk).join('[REDACTED]').split(computer?.token ?? '\0no-token').join('[REDACTED]');
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function until<T>(label: string, fn: () => Promise<T | false | null | undefined>, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  do {
    try { const found = await fn(); if (found) return found; } catch (e) { last = e; }
    await sleep(200);
  } while (Date.now() < end);
  throw new Error(`${label} timed out${last ? `: ${secret(last instanceof Error ? last.message : last)}` : ''}`);
}
async function containerState() {
  check(/^[a-f0-9]{64}$/.test(mainId) && /^[a-f0-9]{64}$/.test(anchorId), 'Own container identities are not established');
  const inspect = async (id: string) => {
    const raw = await engine.ok('GET', `/containers/${id}/json`);
    // Immediately after restore, Docker can know the task before its metrics
    // collector has a sample. Retry only that documented transient response.
    const metricsDeadline = Date.now() + 10_000;
    let stats: any = null;
    for (;;) {
      const response = await engine.call('GET', `/containers/${id}/stats?stream=false&one-shot=true`);
      if (response.status === 500 && String(response.data?.message).includes('no metrics received')) {
        if (Date.now() >= metricsDeadline) {
          // The restored task can run correctly while Docker's collector loses
          // its metrics attachment. Unknown running usage must not become zero.
          check(raw.State.Running && raw.State.Pid > 0, 'Saved container metrics did not become available');
          break;
        }
        await sleep(200);
        continue;
      }
      check(response.status === 200, `Container metrics failed: HTTP ${response.status}`);
      stats = response.data;
      break;
    }
    return { id, name: raw.Name, pid: raw.State.Pid, running: raw.State.Running, status: raw.State.Status,
      memory_bytes: stats?.memory_stats?.usage ?? (raw.State.Running ? null : 0), memory_stats: stats?.memory_stats ?? null,
      cpu_total_usage: stats?.cpu_stats?.cpu_usage?.total_usage ?? null,
      metrics_available: stats !== null };
  };
  return { main: await inspect(mainId), anchor: await inspect(anchorId) };
}
function guestHeaders() { check(computer?.token, 'Computer token missing'); return { authorization: `Bearer ${computer.token}` }; }
function viewerOrigin() { check(computer?.externalUrl, 'Computer viewer URL missing'); return computer.externalUrl; }
async function request(path: string, body?: object, method = body === undefined ? 'GET' : 'POST', gateway = true, authenticated = true) {
  check(computer, 'Computer not created');
  return fetch(`${gateway ? viewerOrigin() : computer.internalUrl}${path}`, {
    method, headers: { connection: 'close', ...(authenticated ? guestHeaders() : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(40_000),
  });
}
async function api(path: string, body?: object, method?: string, gateway = true): Promise<any> {
  const r = await request(path, body, method, gateway);
  if (!r.ok) { await r.body?.cancel(); throw new Error(`${gateway ? 'Gateway' : 'Guest'} ${path}: HTTP ${r.status}`); }
  return r.status === 204 ? null : r.json();
}
async function python(code: string, args: string[] = []) {
  const r = await api('/api/v1/exec', { cmd: 'python3', args: ['-c', code, ...args], shell: false, timeout_ms: 20_000 });
  check(r.exit_code === 0 && !r.timed_out && !r.truncated, `Guest Python failed: ${secret(r.stderr)}`);
  return JSON.parse(r.stdout);
}
async function bootControlPlane() {
  controller = new IdleController(provider, { idleMs, pollMs: 100, readyTimeoutMs: 40_000, requestTimeoutMs: 10_000 });
  app = await buildServer({ provider, lifecycle: controller, gatewayUrl: publicUrl, client: new InstanceClient(),
    catalog: loadCatalog(new URL('../docs/mcp-tools.json', import.meta.url)), version: 'lifecycle-e2e', psk, readyTimeoutMs: 40_000 });
  await app.listen({ host: '127.0.0.1', port });
}
async function held() { check(computer, 'Computer not created'); await controller.keepAwake(computer.id, 600_000); }
async function allowIdle() { check(computer, 'Computer not created'); await controller.allowIdle(computer.id); }
async function running(label: string) {
  check(computer, 'Computer not created');
  const c = await provider.get(computer.id);
  check(c && !c.stopped && !c.hibernated, `${label}: computer did not remain running`);
  const state = await containerState(); check(state.main.running && state.main.pid > 0, `${label}: application container process missing`);
  return c;
}
async function saved(label: string) {
  check(computer, 'Computer not created');
  const started = Date.now();
  const c = await until(`${label} automatic idle save`, async () => {
    const now = await provider.get(computer!.id);
    if (!now?.hibernated || !now.stopped) return null;
    const raw = await engine.ok('GET', `/containers/${mainId}/json`);
    // PID zero and a checkpoint directory can precede daemon completion. Require
    // the provider's durable successful-receipt promotion before claiming saved.
    return new RegExp(`^/${computer!.id}--saved-[a-f0-9]{16}$`).test(raw.Name) ? now : null;
  });
  const state = await containerState();
  check(state.main.running === false && state.main.pid === 0 && state.main.memory_bytes === 0, `${label}: application process/RAM remains while saved`);
  check(state.anchor.running === true && state.anchor.pid > 0, `${label}: network anchor is not running`);
  const evidence = { label, automatic_save_wait_ms: Date.now() - started, application_state: c.status, saved_containers: state };
  result.cycles.push(evidence);
  console.log(`${label}: automatically checkpointed; application PID and memory are zero`);
  return evidence as Record<string, any>;
}
async function passiveNoWake(label: string) {
  const observed: Record<string, number> = {};
  for (const [path, authenticated, expected] of [
    ['/health', true, 503], ['/api/v1/metrics', true, 503], ['/api/v1/lifecycle', true, 503],
    ['/api/v1/capabilities', false, 401], ['/', false, 200],
  ] as const) {
    const r = await request(path, undefined, 'GET', true, authenticated);
    observed[`${authenticated ? 'authenticated' : 'anonymous'} ${path}`] = r.status;
    await r.body?.cancel();
    check(r.status === expected, `${label}: ${path} returned ${r.status}, expected ${expected}`);
  }
  await sleep(idleMs + 100);
  check(computer && (await provider.get(computer.id))?.hibernated, `${label}: passive requests woke the computer`);
  check((await containerState()).main.pid === 0, `${label}: passive requests started the application`);
  return observed;
}

const probeCode = `import os,sys,json,time,threading,secrets,hashlib
from http.server import BaseHTTPRequestHandler,HTTPServer
payload=bytearray(os.urandom(64*1024*1024))
state={'token':secrets.token_hex(32),'pid':os.getpid(),'start_ticks':open('/proc/self/stat').read().rsplit(')',1)[1].split()[19],'boot_id':open('/proc/sys/kernel/random/boot_id').read().strip(),'payload_sha256':hashlib.sha256(payload).hexdigest(),'payload_bytes':len(payload),'counter':0}
def tick():
 while True:
  state['counter']+=1
  time.sleep(0.1)
threading.Thread(target=tick,daemon=True).start()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  state['payload_sha256']=hashlib.sha256(payload).hexdigest()
  state['start_ticks']=open('/proc/self/stat').read().rsplit(')',1)[1].split()[19]
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(state).encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()
`;
const probeReadCode = "import urllib.request,sys;print(urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1],timeout=5).read().decode())";
const readProbe = () => python(probeReadCode, [String(probe.port)]);
const identity = (s: any) => [s.pid, s.token, s.payload_sha256, s.payload_bytes];
async function guiState() {
  const w = (await api('/api/v1/windows')).windows.find((w: any) => w.id === gui.window.id);
  check(w?.pid === gui.pid && w.title === gui.title, 'GUI window/process identity changed');
  const accessible = await until('AT-SPI text field readiness', async () => {
    const found = await api('/api/v1/a11y/find', { window: gui.window.id, role: 'text_field' });
    return found.matches?.length > 0 ? found : null;
  }, 15_000);
  const sentinel = `clipboard-sentinel-${randomUUID()}`;
  await api('/api/v1/clipboard', { text: sentinel }, 'PUT');
  const before = await until('Clipboard sentinel', async () => { const c = await api('/api/v1/clipboard'); return c.text === sentinel ? c : null; }, 10_000);
  await api(`/api/v1/windows/${w.id}/activate`, {});
  await api('/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'a'] });
  await api('/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'c'] });
  const copied = await until('Original unsaved GUI text', async () => {
    const c = await api('/api/v1/clipboard'); return c.text === gui.marker && c.generation > before.generation ? c : null;
  }, 10_000);
  const proc = await python("import json,sys;print(json.dumps({'start_ticks':open('/proc/'+sys.argv[1]+'/stat').read().rsplit(')',1)[1].split()[19]}))", [String(gui.pid)]);
  return { window_id: w.id, pid: gui.pid, start_ticks: proc.start_ticks, unsaved_text: copied.text,
    clipboard_generation: copied.generation, a11y_text_field_matches: accessible.matches.length,
    a11y_snapshot_id: accessible.snapshot_id };
}
async function screenshot(label: string) {
  const r = await request(`/api/v1/screenshot?window=${encodeURIComponent(gui.window.id)}&format=png`);
  const png = Buffer.from(await r.arrayBuffer());
  check(r.ok && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'GUI PNG capture failed');
  const file = join(dirname(output), `gui-${label}.png`);
  await writeFile(file, png);
  return { file: `gui-${label}.png`, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
}
async function restored(label: string, cycle: Record<string, any>) {
  const after = await readProbe();
  check(JSON.stringify(identity(after)) === JSON.stringify(identity(initial)), `${label}: application PID/RAM identity changed`);
  check(after.counter > initial.counter, `${label}: RAM counter did not continue`);
  cycle.after_probe = after;
  cycle.after_gui = await guiState();
  cycle.after_png = await screenshot(label);
  cycle.screenshot_identical = cycle.after_png.sha256 === result.initial_png.sha256;
  check(cycle.screenshot_identical, `${label}: restored GUI screenshot differs`);
  cycle.after_containers = await containerState();
  check(cycle.after_containers.main.running && cycle.after_containers.main.pid > 0, `${label}: restored application process missing`);
  check(computer && !(await provider.get(computer.id))?.hibernated, `${label}: checkpoint intent was not consumed`);
  cycle.passed = true;
}
async function tool(name: string, args: object) {
  const r = await fetch(`${orchestratorUrl}/mcp`, {
    method: 'POST', headers: { connection: 'close', authorization: `Bearer ${psk}`, 'x-ozwell-user-id': 'lifecycle-smoke',
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(90_000),
  });
  const raw = await r.text();
  const payload = JSON.parse(raw.trimStart().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join(''));
  check(r.ok && !payload.error && payload.result && !payload.result.isError, `Orchestrator MCP ${name} failed: ${secret(JSON.stringify(payload))}`);
  return JSON.parse(payload.result.content.find((c: any) => c.type === 'text').text);
}
async function websocket() {
  return new Promise<Duplex>((resolve, reject) => {
    const req = httpRequest(`${viewerOrigin()}/websockify`, { headers: { ...guestHeaders(), connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } });
    const timer = setTimeout(() => req.destroy(new Error('Gateway WebSocket upgrade timed out')), 40_000);
    req.once('error', (e) => { clearTimeout(timer); reject(e); });
    req.once('response', (r) => { clearTimeout(timer); r.resume(); reject(new Error(`Gateway WebSocket rejected: ${r.statusCode}`)); });
    req.once('upgrade', (_response, socket) => {
      clearTimeout(timer); sockets.add(socket); socket.on('error', () => {}); socket.resume(); resolve(socket);
    });
    req.end();
  });
}

await mkdir(dirname(output), { recursive: true });
try {
  const existing = await engine.ok('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['org.mieweb.ozwell-computer.managed=true'] }))}`);
  check(existing.length === 0, 'Disposable lab must start with no managed computers; refusing to sweep existing desktops');
  result.versions = { docker: await engine.ok('GET', '/version'), node: process.version, host: (await readFile('/proc/version', 'utf8')).trim() };
  console.log('Creating a native desktop through DockerCheckpointProvider');
  const createdAt = Date.now();
  computer = await provider.create({ owner: { id: 'lifecycle-smoke' }, displayName: 'Disposable complete lifecycle test' });
  // Use the actual viewer origin: fetch implementations may discard a manually
  // overridden Host header. This hosts entry lives only in the disposable lab.
  check(/^ozc-[a-z2-7]{10}$/.test(computer.id), 'Unexpected lab computer identifier');
  check(computer.externalUrl === publicUrl.replace('{id}', computer.id), 'Unexpected lab viewer origin');
  await appendFile('/etc/hosts', `\n127.0.0.1 ${new URL(viewerOrigin()).hostname}\n`);
  const rows = await engine.ok('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`org.mieweb.ozwell-computer.instance-id=${computer.id}`, 'org.mieweb.ozwell-computer.checkpoint-version=1'] }))}`);
  check(rows.length === 1 && /^[a-f0-9]{64}$/.test(rows[0].Id), 'Created application identity ambiguous');
  mainId = rows[0].Id;
  const raw = await engine.ok('GET', `/containers/${mainId}/json`);
  anchorId = raw.Config.Labels['org.mieweb.ozwell-computer.network-anchor'];
  result.instance_id = computer.id; result.application_container_id = mainId; result.anchor_container_id = anchorId;
  result.application_image_id = raw.Image;
  result.criu_config = raw.HostConfig.Annotations?.['org.criu.config'];
  await until('First guest boot', async () => { const r = await request('/health', undefined, 'GET', false); await r.body?.cancel(); return r.status === 204; }, 180_000);
  result.first_boot_ready_ms = Date.now() - createdAt;
  await bootControlPlane(); await held();
  result.guest_environment = await python(`import json,platform,subprocess,hashlib,pathlib
root=pathlib.Path('/opt/ozwell-computer')
package=subprocess.run(['dpkg-query','-W','-f='+chr(36)+'{Version}','ozwell-computer'],text=True,capture_output=True).stdout.strip()
files=['server.js','lifecycle.js','routes/lifecycle.js']
print(json.dumps({'kernel':platform.release(),'architecture':platform.machine(),'os_release':open('/etc/os-release').read(),'ozwell_package':package or None,'app_version':json.loads((root/'package.json').read_text()).get('version') if (root/'package.json').exists() else None,'revision':(root/'REVISION').read_text().strip() if (root/'REVISION').exists() else None,'dist_sha256':{name:hashlib.sha256((root/'dist'/name).read_bytes()).hexdigest() for name in files if (root/'dist'/name).exists()}}))`);
  result.guest_capabilities_version = (await api('/api/v1/capabilities')).version;
  const probePort = randomInt(20_000, 50_000), title = `lifecycle-smoke-${randomUUID()}`;
  probe = await python(`import json,subprocess,sys
p=subprocess.Popen([sys.executable,'-u','-c',sys.argv[1],sys.argv[2]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
g=subprocess.Popen(['zenity','--entry','--title='+sys.argv[3],'--text=Unsaved complete lifecycle entry'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
def start(pid):
 try: return open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()[19]
 except FileNotFoundError: return None
print(json.dumps({'pid':p.pid,'start_ticks':start(p.pid),'port':int(sys.argv[2]),'gui_pid':g.pid,'gui_start_ticks':start(g.pid)}))`, [probeCode, String(probePort), title]);
  initial = await until('RAM probe startup', readProbe);
  check(initial.pid === probe.pid, 'RAM probe PID mismatch'); result.initial_probe = initial;
  const window = await until('Unsaved GUI window', async () => (await api('/api/v1/windows')).windows.find((w: any) => w.title === title), 20_000);
  gui = { window, pid: probe.gui_pid, start_ticks: probe.gui_start_ticks, title, marker: `unsaved-${randomUUID()}` };
  await api(`/api/v1/windows/${window.id}/activate`, {});
  await api('/api/v1/input/keyboard', { action: 'type', text: gui.marker }); // typed exactly once
  result.initial_gui = await guiState(); result.initial_png = await screenshot('before');

  console.log('Verifying keep-awake lease blocks automatic and explicit hibernation');
  await sleep(idleMs * 2); await running('Keep-awake lease');
  await controller.hibernate(computer.id).then(() => { throw new Error('Keep-awake lease did not block save'); }, (e) => check(e.reason === 'not_idle', `Wrong lease refusal: ${e.message}`));
  result.checks.keep_awake_blocks_save = true;
  await allowIdle();
  const cycle1 = await saved('viewer-wake');
  cycle1.passive_no_wake = await passiveNoWake('viewer-wake');
  const wakeStarted = Date.now();
  const viewer = await request('/');
  check(viewer.status === 200 && (viewer.headers.get('content-type') ?? '').includes('text/html'), 'Authenticated viewer did not restore and serve its HTML');
  await viewer.arrayBuffer(); cycle1.wake_to_viewer_ms = Date.now() - wakeStarted;
  await held(); await restored('after-viewer', cycle1);

  console.log('Verifying open SSE and WebSocket viewers prevent idle save');
  const abort = new AbortController(); aborters.add(abort);
  const stream = await fetch(`${viewerOrigin()}/api/v1/events`, { headers: guestHeaders(), signal: abort.signal });
  check(stream.ok, 'Viewer event stream failed');
  await allowIdle(); await sleep(idleMs * 2); await running('Open SSE stream');
  check((await api('/api/v1/lifecycle', undefined, undefined, false)).connections > 0, 'SSE connection not counted in guest');
  result.checks.sse_blocks_save = true;
  const ws = await websocket();
  abort.abort(); aborters.delete(abort);
  await sleep(idleMs * 2); await running('Open WebSocket viewer');
  check((await api('/api/v1/lifecycle', undefined, undefined, false)).connections > 0, 'WebSocket connection not counted in guest');
  result.checks.websocket_blocks_save = true;
  await held(); ws.destroy(); sockets.delete(ws);

  console.log('Verifying detached command jobs block idle save after their HTTP response ends');
  const job = await api('/api/v1/exec', { cmd: 'sleep 30', wait_ms: 0 });
  check(job.state === 'running', 'Detached job failed to start');
  await allowIdle(); await sleep(idleMs * 2); await running('Detached command job');
  check((await api('/api/v1/lifecycle', undefined, undefined, false)).running_jobs > 0, 'Detached job not counted');
  await controller.hibernate(computer.id).then(() => { throw new Error('Detached job did not block save'); }, (e) => check(e.reason === 'not_idle', `Wrong job refusal: ${e.message}`));
  result.checks.command_job_blocks_save = true;
  await api(`/api/v1/exec/jobs/${job.job_id}`, undefined, 'DELETE');
  const cycle2 = await saved('mcp-wake');
  const mcpStarted = Date.now();
  const command = `python3 -c 'import urllib.request;print(urllib.request.urlopen("http://127.0.0.1:${probe.port}",timeout=5).read().decode())'`;
  const mcpProbe = await tool('run_command', { instance_id: computer.id, command, wait_ms: 10_000 });
  cycle2.wake_to_mcp_result_ms = Date.now() - mcpStarted;
  check(mcpProbe.exit_code === 0, 'Restored MCP command failed');
  check(JSON.stringify(identity(JSON.parse(mcpProbe.stdout))) === JSON.stringify(identity(initial)), 'MCP wake did not retain original RAM');
  cycle2.mcp_probe = JSON.parse(mcpProbe.stdout);
  await held(); await restored('after-mcp', cycle2);

  await allowIdle();
  const cycle3 = await saved('controller-restart');
  console.log('Restarting the external control plane while the application remains checkpointed');
  await app!.close(); app = undefined;
  provider = makeProvider();
  const discovered = await provider.get(computer.id);
  check(discovered?.hibernated && discovered.stopped, 'Fresh provider did not recover saved guest metadata');
  await bootControlPlane();
  cycle3.passive_no_wake = await passiveNoWake('controller-restart');
  result.checks.controller_restart_preserves_sleep = true;
  const restartWake = Date.now();
  await api('/api/v1/capabilities'); cycle3.wake_after_restart_ms = Date.now() - restartWake;
  await held(); await restored('after-controller-restart', cycle3);
  result.passed = true;
} catch (e) {
  result.error = secret(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  console.error(`Docker checkpoint lifecycle test failed: ${result.error}`);
  if (computer) {
    result.failure_containers = await containerState().catch((failure) => ({ error: secret(failure.message) }));
    const filters = encodeURIComponent(JSON.stringify({ label: [`org.mieweb.ozwell-computer.target=${mainId}`, 'org.mieweb.ozwell-computer.operation-version=1'] }));
    result.failure_workers = await engine.ok('GET', `/containers/json?all=1&filters=${filters}`).then((rows) => rows.map((row: any) => ({ id: row.Id, status: row.Status, state: row.State })), () => []);
  }
} finally {
  for (const abort of aborters) abort.abort();
  for (const socket of sockets) socket.destroy();
  if (app) await app.close().catch((e) => { result.cleanup_error = secret(e.message); });
  if (computer) await provider.destroy(computer.id).catch((e) => { result.cleanup_error = secret(e.message); });
  result.finished_at = new Date().toISOString();
  await writeFile(output, secret(JSON.stringify(result, null, 2)) + '\n');
  console.log(JSON.stringify({ passed: result.passed, cycles: result.cycles.length, checks: result.checks, output }));
}
