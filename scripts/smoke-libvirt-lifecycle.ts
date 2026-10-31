#!/usr/bin/env node
// Actual libvirt provider + idle controller + HTTP/MCP gateway smoke test.
// ONLY for the disposable container created by libvirt-lifecycle-lab.sh.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { appendFile, readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { LibvirtProvider, type LibvirtDependencies } from '../orchestrator/src/providers/libvirt.ts';
import type { Computer } from '../orchestrator/src/providers/types.ts';
import { IdleController } from '../orchestrator/src/lifecycle.ts';
import { InstanceClient } from '../orchestrator/src/instance-client.ts';
import { loadCatalog } from '../orchestrator/src/mcp.ts';
import { buildServer } from '../orchestrator/src/server.ts';

if (process.env.OZC_LIFECYCLE_LAB !== '1' || process.env.LIBVIRT_STORAGE_DIR !== '/lab/storage' || process.env.LIBVIRT_IMAGE_DIR !== '/lab/image') {
  throw new Error('Use libvirt-lifecycle-lab.sh: this test creates and deletes its own VM inside a disposable container');
}
const output = process.argv[2] ?? '/lab/results/results.json';
const idleMs = 1500;
const port = 18090;
const publicUrl = `http://{id}.desktop.test:${port}`;
const orchestratorUrl = `http://127.0.0.1:${port}`;
const psk = randomBytes(24).toString('base64url');
const env = { ...process.env, LIBVIRT_PUBLIC_URL: publicUrl };
const exec = promisify(execFile);
const skipNwfilter = process.env.OZC_LAB_SKIP_NWFILTER === '1';
// This adapter belongs only to the explicitly guarded, disposable lab. It records
// a private serial log for failure diagnostics. The optional filter exemption is
// exclusively for nested kernels lacking ebtables support, never for production.
const dependencies: LibvirtDependencies = { run: async (file, args) => {
  const define = file === 'virsh' ? args.indexOf('define') : -1;
  if (define >= 0) {
    const path = args[define + 1];
    const own = /^\/lab\/storage\/(ozc-[a-z2-7]{10})\/domain\.xml$/.exec(path ?? '');
    if (!own) throw new Error('Lab XML adapter refused a domain outside its disposable storage');
    let xml = await readFile(path, 'utf8');
    if (skipNwfilter) xml = xml.replace(/<filterref\b[^>]*(?:\/>|>[\s\S]*?<\/filterref>)/g, '');
    xml = xml.replace(/<serial\b[^>]*>[\s\S]*?<\/serial>/, (serial) => serial.includes('<log') ? serial
      : serial.replace('>', `><log file="/lab/storage/${own[1]}/serial.log" append="on"/>`));
    await writeFile(path, xml, { mode: 0o600 });
  }
  return (await exec(file, args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout;
} };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const result: Record<string, any> = {
  started_at: new Date().toISOString(), passed: false, idle_ms: idleMs, nwfilter_enforced: !skipNwfilter,
  scope: 'Real seeded libvirt VM, production LibvirtProvider + IdleController + orchestrator HTTP/WebSocket/MCP gateway; TCG x86_64 guest on disposable Docker host.',
  limitations: ['Local software emulation; timings are not KVM production benchmarks.', 'Controller restart is tested; host reboot, storage corruption and cross-host restore are not simulated.', 'Libvirt and host page-cache memory remain; the guest QEMU process must disappear.'],
  cycles: [], checks: {},
};
if (skipNwfilter) result.limitations.push('Host kernel cannot apply libvirt nwfilter; lab-only XML adapter omits filterref; production provider still requires anti-spoof filters; not security deployment validation.');
const makeProvider = () => new LibvirtProvider(new URL('libvirt:///system'), env, dependencies);
let provider = makeProvider();
let controller!: IdleController;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let computer: Computer | undefined;
let uuid = '';
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
async function virsh(...args: string[]) {
  return (await exec('virsh', ['--connect', 'qemu:///system', ...args], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
}
async function qemuProcesses() {
  const found = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (!/(?:^|\/)(?:qemu-system-[^/]+|qemu-kvm)$/.test(args[0]) || args[args.indexOf('-uuid') + 1] !== uuid) continue;
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      found.push({ pid: Number(pid), rss_bytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024 });
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
  }
  return found;
}
function guestHeaders() { check(computer?.token, 'Computer token missing'); return { authorization: `Bearer ${computer.token}` }; }
function viewerOrigin() { check(computer?.externalUrl, 'Computer viewer URL missing'); return computer.externalUrl; }
async function request(path: string, body?: object, method = body === undefined ? 'GET' : 'POST', gateway = true, authenticated = true) {
  check(computer, 'Computer not created');
  return fetch(`${gateway ? viewerOrigin() : computer.internalUrl}${path}`, {
    method, headers: { ...(authenticated ? guestHeaders() : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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
  check((await qemuProcesses()).length === 1, `${label}: QEMU process missing`);
  return c;
}
async function saved(label: string) {
  check(computer, 'Computer not created');
  const started = Date.now();
  const c = await until(`${label} automatic idle save`, async () => {
    const now = await provider.get(computer!.id); return now?.hibernated && now.stopped ? now : null;
  });
  const info = await virsh('dominfo', c.id);
  check(/^Managed save:\s+yes\s*$/m.test(info), `${label}: managed save missing`);
  check((await qemuProcesses()).length === 0, `${label}: QEMU process remains while hibernated`);
  const image = await stat(`/var/lib/libvirt/qemu/save/${c.id}.save`);
  const evidence = { label, automatic_save_wait_ms: Date.now() - started, domain_state: c.status, qemu_processes: await qemuProcesses(), managed_save_bytes: image.size };
  result.cycles.push(evidence);
  console.log(`${label}: automatically hibernated; QEMU absent`);
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
  check((await qemuProcesses()).length === 0, `${label}: passive requests spawned QEMU`);
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
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(state).encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()
`;
const probeReadCode = "import urllib.request,sys;print(urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1],timeout=5).read().decode())";
const readProbe = () => python(probeReadCode, [String(probe.port)]);
const identity = (s: any) => [s.boot_id, s.pid, s.start_ticks, s.token, s.payload_sha256, s.payload_bytes];
async function guiState() {
  const w = (await api('/api/v1/windows')).windows.find((w: any) => w.id === gui.window.id);
  check(w?.pid === gui.pid && w.title === gui.title, 'GUI window/process identity changed');
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
  check(proc.start_ticks === gui.start_ticks, 'GUI process was restarted');
  return { window_id: w.id, pid: gui.pid, start_ticks: proc.start_ticks, unsaved_text: copied.text, clipboard_generation: copied.generation };
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
  check(JSON.stringify(identity(after)) === JSON.stringify(identity(initial)), `${label}: guest boot/process/RAM identity changed`);
  check(after.counter > initial.counter, `${label}: RAM counter did not continue`);
  cycle.after_probe = after;
  cycle.after_gui = await guiState();
  cycle.after_png = await screenshot(label);
  cycle.screenshot_identical = cycle.after_png.sha256 === result.initial_png.sha256;
  check(cycle.screenshot_identical, `${label}: restored GUI screenshot differs`);
  cycle.after_qemu_processes = await qemuProcesses();
  check(cycle.after_qemu_processes.length === 1, `${label}: restored QEMU process missing`);
  check(computer && /^Managed save:\s+no\s*$/m.test(await virsh('dominfo', computer.id)), `${label}: managed save not consumed`);
  cycle.passed = true;
}
async function tool(name: string, args: object) {
  const r = await fetch(`${orchestratorUrl}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${psk}`, 'x-ozwell-user-id': 'lifecycle-smoke',
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
  check((await provider.listAll()).length === 0, 'Disposable lab must start with no managed computers');
  result.versions = { libvirt: (await exec('virsh', ['--version=long'])).stdout.trim(), node: process.version, host: (await readFile('/proc/version', 'utf8')).trim() };
  console.log('Creating a seeded Ozwell VM through LibvirtProvider');
  const createdAt = Date.now();
  computer = await provider.create({ owner: { id: 'lifecycle-smoke' }, displayName: 'Disposable complete lifecycle test' });
  // Use the actual viewer origin: fetch implementations may discard a manually
  // overridden Host header. This hosts entry lives only in the disposable lab.
  check(/^ozc-[a-z2-7]{10}$/.test(computer.id), 'Unexpected lab computer identifier');
  check(computer.externalUrl === publicUrl.replace('{id}', computer.id), 'Unexpected lab viewer origin');
  await appendFile('/etc/hosts', `\n127.0.0.1 ${new URL(viewerOrigin()).hostname}\n`);
  uuid = await virsh('domuuid', computer.id);
  result.instance_id = computer.id; result.uuid = uuid;
  await until('First guest boot', async () => { const r = await request('/health', undefined, 'GET', false); await r.body?.cancel(); return r.status === 204; }, 180_000);
  result.first_boot_ready_ms = Date.now() - createdAt;
  result.versions.qemu = JSON.parse(await virsh('qemu-monitor-command', computer.id, '{"execute":"query-version"}')).return;
  await bootControlPlane(); await held();
  const guestUuid = await python("import json,subprocess;print(json.dumps(subprocess.check_output(['sudo','-n','cat','/sys/class/dmi/id/product_uuid'],text=True).strip()))");
  check(guestUuid.toLowerCase() === uuid.toLowerCase(), 'Guest endpoint DMI UUID differs from provider domain');
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
  console.log('Restarting the external control plane while the guest remains saved');
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
  console.error(`Whole lifecycle test failed: ${result.error}`);
  if (computer) {
    result.failure_domain_info = await virsh('dominfo', computer.id).catch((failure) => secret(failure.message));
    result.failure_qemu_processes = await qemuProcesses().catch(() => []);
    result.failure_serial_tail = await readFile(`/lab/storage/${computer.id}/serial.log`, 'utf8').then((text) => secret(text.slice(-24_000)), () => null);
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
