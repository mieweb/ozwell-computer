#!/usr/bin/env node
// Manual, destructive-to-execution smoke test: use ONLY an existing disposable Linux VM.
// Run on its libvirt host with /proc access; requires virsh, guest Python 3 and Ozwell exec.
// Restores with ordinary `virsh start`; never discards saved state or cold-boots on failure.
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomInt, randomUUID } from 'node:crypto';

const { values: opts } = parseArgs({ options: {
  uri: { type: 'string', default: 'qemu:///system' }, domain: { type: 'string' }, url: { type: 'string' },
  'token-env': { type: 'string', default: 'OZWELL_COMPUTER_TOKEN' }, output: { type: 'string' },
  cycles: { type: 'string', default: '2' }, 'sleep-ms': { type: 'string', default: '5000' },
  'require-gui': { type: 'boolean', default: false },
  help: { type: 'boolean' },
} });
if (opts.help || !opts.domain || !opts.url) {
  console.log('Usage: node scripts/smoke-libvirt-managedsave.mjs --domain DISPOSABLE_VM --url http://guest:8080 [--uri qemu:///system] [--token-env OZWELL_COMPUTER_TOKEN] [--output results.json] [--cycles 2] [--sleep-ms 5000] [--require-gui]');
  process.exit(opts.help ? 0 : 1);
}
const cycles = Number(opts.cycles), sleepMs = Number(opts['sleep-ms']);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20 || !Number.isInteger(sleepMs) || sleepMs < 0 || sleepMs > 300_000) throw new Error('cycles must be 1..20; sleep-ms must be 0..300000');
const base = new URL(opts.url);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('url must be an HTTP(S) base URL without credentials, query or fragment');
const token = process.env[opts['token-env']];
if (!token) throw new Error(`Set the access token in ${opts['token-env']}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const clean = (s) => String(s).split(token).join('[REDACTED]');
const result = {
  started_at: new Date().toISOString(), domain: opts.domain, uri: opts.uri, endpoint: base.toString(), cycles: [],
  gui_required: opts['require-gui'],
  scope: 'Real existing Linux VM, Ozwell HTTP exec, 64 MiB nonzero RAM probe, optional unsaved GUI entry. No idle scheduler or wake gateway.',
  limitations: ['Same host /proc and guest DMI product_uuid required.', 'No network-session, host-upgrade, cross-host or crash-recovery guarantees.', 'Host page cache and libvirt controller memory may remain.'],
};
let uuid, name, launched, initial, gui;
async function virsh(command, args = [], domain = true) {
  const { stdout } = await run('virsh', ['--connect', opts.uri, command, ...(domain ? ['--domain', uuid ?? opts.domain] : []), ...args], {
    env: { ...process.env, LC_ALL: 'C' }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(new URL(path, base), { method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!r.ok) throw new Error(`Ozwell ${path}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function python(code, args = []) {
  const r = await api('/api/v1/exec', { cmd: 'python3', args: ['-c', code, ...args], shell: false, timeout_ms: 10_000 });
  if (r.exit_code !== 0 || r.timed_out || r.truncated) throw new Error(`guest Python failed: ${clean(r.stderr)}`);
  return JSON.parse(r.stdout);
}
async function until(label, fn, timeout = 90_000) {
  const end = Date.now() + timeout;
  let error;
  do { try { const v = await fn(); if (v) return v; } catch (e) { error = e; } await sleep(500); } while (Date.now() < end);
  throw new Error(`${label} timed out${error ? `: ${clean(error.message)}` : ''}`);
}
function check(ok, message) { if (!ok) throw new Error(message); }
async function processes() {
  const found = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (!/(?:^|\/)(?:qemu-system-[^/]+|qemu-kvm)$/.test(args[0])) continue;
      if (args[args.indexOf('-uuid') + 1] !== uuid) continue;
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      found.push({ pid: Number(pid), rss_bytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024 });
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
  }
  return found;
}
async function disks() {
  const listing = await virsh('domblklist', ['--details']);
  return Promise.all(listing.split('\n').flatMap((line) => {
    const m = /^\s*file\s+disk\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return m ? [m] : [];
  }).map(async ([, target, path]) => {
    const s = await stat(path);
    return { target, path, dev: s.dev, ino: s.ino, size: s.size, mtime_ms: s.mtimeMs };
  }));
}
async function savedImage() {
  for (const dir of ['/var/lib/libvirt/qemu/save', join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'libvirt/qemu/save')]) {
    try { const path = join(dir, `${name}.save`), s = await stat(path); return { path, size_bytes: s.size, allocated_bytes: s.blocks * 512 }; } catch { /* optional evidence */ }
  }
  return { size_bytes: null, reason: 'Save image path unavailable or unreadable' };
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
const readProbe = () => python(`import json,urllib.request,sys
print(urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1],timeout=3).read().decode())`, [String(launched.port)]);
const identity = (s) => [s.boot_id, s.pid, s.start_ticks, s.token, s.payload_sha256, s.payload_bytes];
async function guiState() {
  const w = (await api('/api/v1/windows')).windows.find((w) => w.id === gui.window.id);
  check(w?.pid === gui.pid && w.title === gui.title, 'GUI window identity changed');
  // Copy from the real widget after replacing the clipboard, so stale clipboard data cannot pass.
  const sentinel = `clipboard-sentinel-${randomUUID()}`;
  await api('/api/v1/clipboard', { text: sentinel }, 'PUT');
  const before = await until('Clipboard sentinel', async () => {
    const c = await api('/api/v1/clipboard'); return c.text === sentinel ? c : null;
  }, 10_000);
  await api(`/api/v1/windows/${w.id}/activate`, {});
  await api('/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'a'] });
  await api('/api/v1/input/keyboard', { action: 'hotkey', keys: ['ctrl', 'c'] });
  const copied = await until('Unsaved GUI entry text', async () => {
    const c = await api('/api/v1/clipboard'); return c.text === gui.marker && c.generation > before.generation ? c : null;
  }, 10_000);
  const proc = await python(`import json,sys
print(json.dumps({'start_ticks':open('/proc/'+sys.argv[1]+'/stat').read().rsplit(')',1)[1].split()[19]}))`, [String(gui.pid)]);
  check(proc.start_ticks === gui.start_ticks, 'GUI process was restarted');
  return { window_id: w.id, pid: gui.pid, start_ticks: proc.start_ticks, unsaved_text: copied.text,
    verification: 'copy from widget after fresh clipboard sentinel', clipboard_generation: copied.generation };
}
async function guiScreenshot(label) {
  const r = await fetch(new URL(`/api/v1/screenshot?window=${encodeURIComponent(gui.window.id)}&format=png`, base), {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const png = Buffer.from(await r.arrayBuffer());
  check(r.ok && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'GUI PNG capture failed');
  const file = opts.output ? join(dirname(opts.output), `gui-${label}.png`) : null;
  if (file) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, png); }
  return { file, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
}
try {
  uuid = await virsh('domuuid'); check(/^[0-9a-f-]{36}$/i.test(uuid), 'Invalid domain UUID');
  name = await virsh('domname'); check(!name.includes('/'), 'Invalid domain name');
  result.uuid = uuid;
  // `virsh version` probes the host architecture's emulator, which can differ from this VM.
  result.versions = { libvirt: (await run('virsh', ['--version=long'])).stdout.trim(),
    qemu: JSON.parse(await virsh('qemu-monitor-command', ['{"execute":"query-version"}'])).return,
    node: process.version, host: await readFile('/proc/version', 'utf8') };
  result.domain_xml = await virsh('dumpxml');
  const info = await virsh('dominfo');
  check(/^Persistent:\s+yes$/m.test(info), 'Domain must be persistent');
  check(/^running$/i.test(await virsh('domstate')), 'Domain must already be running');
  check(/^Managed save:\s+no$/m.test(info), 'Domain already has a managed save');
  check((await processes()).length === 1, 'Expected exactly one local QEMU domain process; run on its libvirt host');
  result.disks = await disks(); check(result.disks.length > 0, 'Expected a file-backed VM disk');
  await until('Ozwell readiness', async () => { await api('/health'); return true; });
  result.guest_uuid = await python(`import json,subprocess
try:
 uuid=open('/sys/class/dmi/id/product_uuid').read().strip()
except PermissionError:
 uuid=subprocess.check_output(['sudo','-n','cat','/sys/class/dmi/id/product_uuid'],text=True,timeout=5).strip()
print(json.dumps(uuid))`);
  check(result.guest_uuid.toLowerCase() === uuid.toLowerCase(), 'Ozwell endpoint DMI UUID does not match the libvirt domain; refusing to spawn probes or save');
  result.guest_environment = await python(`import json,platform,subprocess,shutil
version=subprocess.run(['dpkg-query','-W','-f='+chr(36)+'{Version}','ozwell-computer'],text=True,capture_output=True).stdout.strip() if shutil.which('dpkg-query') else None
print(json.dumps({'kernel':platform.release(),'architecture':platform.machine(),'os_release':open('/etc/os-release').read(),'ozwell_package':version or None}))`);
  const port = randomInt(20_000, 50_000), title = `managed-save-smoke-${randomUUID()}`;
  launched = await python(`import json,subprocess,sys,shutil
p=subprocess.Popen([sys.executable,'-u','-c',sys.argv[1],sys.argv[2]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
g=subprocess.Popen(['zenity','--entry','--title='+sys.argv[3],'--text=Unsaved managed-save smoke entry'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True) if shutil.which('zenity') else None
def start(pid):
 try: return open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()[19]
 except FileNotFoundError: return None
print(json.dumps({'pid':p.pid,'start_ticks':start(p.pid),'port':int(sys.argv[2]),'gui_pid':g.pid if g else None,'gui_start_ticks':start(g.pid) if g else None}))`, [probeCode, String(port), title]);
  initial = await until('RAM probe startup', readProbe); check(initial.pid === launched.pid, 'Probe PID mismatch');
  result.initial_probe = initial;
  if (launched.gui_pid) {
    try {
      const window = await until('GUI startup', async () => (await api('/api/v1/windows')).windows.find((w) => w.title === title), 15_000);
      const marker = `unsaved-${randomUUID()}`;
      await api(`/api/v1/windows/${window.id}/activate`, {});
      await api('/api/v1/input/keyboard', { action: 'type', text: marker });
      const proc = await python(`import json,sys
print(json.dumps({'start_ticks':open('/proc/'+sys.argv[1]+'/stat').read().rsplit(')',1)[1].split()[19]}))`, [String(launched.gui_pid)]);
      gui = { window, pid: launched.gui_pid, title, marker, ...proc };
      result.initial_gui = await guiState();
      result.initial_gui_png = await guiScreenshot('before');
    } catch (e) { gui = undefined; result.gui_skipped = clean(e.message); }
  } else result.gui_skipped = 'zenity is not installed';
  check(!opts['require-gui'] || gui, `GUI verification is required: ${result.gui_skipped ?? 'unsaved entry not verified'}`);
  for (let i = 0; i < cycles; i++) {
    const cycle = { cycle: i + 1 }; result.cycles.push(cycle);
    cycle.before_probe = await readProbe(); cycle.before_processes = await processes();
    check(cycle.before_processes.length === 1, 'QEMU process missing before save');
    if (gui) cycle.before_gui = await guiState();
    console.log(`Cycle ${i + 1}/${cycles}: saving ${name}`);
    let t = Date.now(); await virsh('managedsave', ['--running']); cycle.save_ms = Date.now() - t;
    cycle.saved_state = await virsh('domstate', ['--reason']); cycle.saved_info = await virsh('dominfo');
    check(/^shut off/.test(cycle.saved_state), 'Domain is not shut off after managedsave');
    check(/^Managed save:\s+yes$/m.test(cycle.saved_info), 'Managed save image is missing');
    cycle.saved_processes = await processes(); check(cycle.saved_processes.length === 0, 'QEMU domain process remains while saved');
    cycle.save_image = await savedImage(); cycle.saved_disks = await disks();
    check(JSON.stringify(cycle.saved_disks.map(({ target, path, dev, ino }) => ({ target, path, dev, ino }))) === JSON.stringify(result.disks.map(({ target, path, dev, ino }) => ({ target, path, dev, ino }))), 'Disk identity changed');
    t = Date.now(); await sleep(sleepMs); cycle.saved_wait_ms = Date.now() - t;
    check((await processes()).length === 0, 'QEMU appeared during saved wait');
    check(JSON.stringify(await disks()) === JSON.stringify(cycle.saved_disks), 'Disk changed while saved');
    console.log(`Cycle ${i + 1}/${cycles}: restoring ${name}`);
    t = Date.now(); await virsh('start'); cycle.start_ms = Date.now() - t;
    await until('Ozwell restore readiness', async () => { await api('/health'); return true; });
    cycle.ready_ms = Date.now() - t;
    await sleep(500); cycle.after_probe = await readProbe();
    check(JSON.stringify(identity(cycle.after_probe)) === JSON.stringify(identity(initial)), 'Guest boot/process/RAM identity changed');
    check(cycle.after_probe.counter > cycle.before_probe.counter, 'RAM counter did not continue');
    cycle.after_processes = await processes(); check(cycle.after_processes.length === 1, 'Restored QEMU process missing');
    check(/^Managed save:\s+no$/m.test(await virsh('dominfo')), 'Managed save was not consumed');
    if (gui) { cycle.after_gui = await guiState(); cycle.after_gui_png = await guiScreenshot(`after-${i + 1}`); }
    cycle.passed = true;
  }
  result.passed = true;
} catch (e) {
  result.passed = false; result.error = clean(e.message); process.exitCode = 1;
  console.error(`Managed-save smoke failed: ${result.error}. Saved state is never discarded automatically.`);
} finally {
  // Clean only our temporary processes, and only when the guest is already running.
  if (launched && uuid && /^running$/i.test(await virsh('domstate').catch(() => ''))) {
    try {
      await python(`import json,os,signal,sys
for pid,expected in json.loads(sys.argv[1]):
 try:
  current=open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()[19]
  if expected and current==expected: os.kill(pid,signal.SIGTERM)
 except ProcessLookupError: pass
 except FileNotFoundError: pass
print('{}')`, [JSON.stringify([[launched.pid, launched.start_ticks], [launched.gui_pid, launched.gui_start_ticks]])]);
    } catch (e) { result.cleanup_error = clean(e.message); }
  }
  result.finished_at = new Date().toISOString();
  if (opts.output) { await mkdir(dirname(opts.output), { recursive: true }); await writeFile(opts.output, clean(JSON.stringify(result, null, 2)) + '\n'); }
  console.log(JSON.stringify({ passed: result.passed, cycles: result.cycles.length, gui_verified: !!gui, output: opts.output ?? null }));
}
