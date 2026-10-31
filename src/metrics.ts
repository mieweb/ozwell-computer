// Prometheus metrics: Node process defaults, container/unit memory from cgroup v2,
// per-command RSS from /proc, and application counters/gauges.
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 20 });

const counter = (name: string, help: string, labelNames: string[] = []) =>
  new client.Counter({ name, help, labelNames, registers: [registry] });
const gauge = (name: string, help: string, labelNames: string[] = []) =>
  new client.Gauge({ name, help, labelNames, registers: [registry] });
const histogram = (name: string, help: string, buckets: number[], labelNames: string[] = []) =>
  new client.Histogram({ name, help, buckets, labelNames, registers: [registry] });

export const m = {
  vncSessions: gauge('ozwell_vnc_sessions', 'Open VNC (RFB) sessions'),
  vncBytes: counter('ozwell_vnc_sent_bytes_total', 'Bytes sent to VNC clients'),
  vncUpdates: counter('ozwell_vnc_updates_total', 'FramebufferUpdate messages sent'),
  vncEncodeSeconds: histogram('ozwell_vnc_update_seconds', 'Time to capture and encode one FramebufferUpdate',
    [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]),
  mcpSessions: gauge('ozwell_mcp_sessions', 'Open MCP sessions'),
  mcpToolCalls: counter('ozwell_mcp_tool_calls_total', 'MCP tool calls', ['tool', 'outcome']),
  sseClients: gauge('ozwell_sse_clients', 'Open /api/v1/events streams'),
  screenshotSeconds: histogram('ozwell_screenshot_seconds', 'Screenshot capture + encode time',
    [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], ['format']),
  httpSeconds: histogram('ozwell_http_request_duration_seconds', 'HTTP request duration',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10], ['method', 'route', 'status']),
  xConnected: gauge('ozwell_x_connected', '1 when the X display is connected'),
  presence: gauge('ozwell_presence_participants', 'Presence participants', ['kind']),
};

// ---- memory from the environment (collected at scrape time)

/** cgroup v2 directory of the whole container (parent of PID 1's init.scope under systemd), or null. */
function containerCgroup(): string | null {
  try {
    const line = readFileSync('/proc/1/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    if (!line) return null;
    let p = line.slice(3).trim();
    if (p.endsWith('/init.scope')) p = dirname(p);
    return join('/sys/fs/cgroup', p);
  } catch {
    return null;
  }
}
const cgroupRoot = containerCgroup();

const readNum = (f: string): number | null => {
  try {
    const v = readFileSync(f, 'utf8').trim();
    return v === 'max' ? null : Number(v);
  } catch {
    return null;
  }
};

const ls = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return []; // not under systemd, or no such slice
  }
};

/**
 * [unit, cgroup directory] of the system services, plus each user's login sessions (the
 * desktop session) and user-manager services (the server and the apps it launched).
 */
function unitCgroups(root: string): [string, string][] {
  const out: [string, string][] = [];
  const add = (dir: string, match: (u: string) => boolean) => {
    for (const u of ls(dir)) if (match(u)) out.push([u, join(dir, u)]);
  };
  add(join(root, 'system.slice'), (u) => u.endsWith('.service'));
  for (const user of ls(join(root, 'user.slice')).filter((d) => d.startsWith('user-') && d.endsWith('.slice'))) {
    const dir = join(root, 'user.slice', user);
    add(dir, (u) => u.startsWith('session-') && u.endsWith('.scope'));
    for (const m of ls(dir).filter((d) => d.startsWith('user@') && d.endsWith('.service'))) add(join(dir, m, 'app.slice'), (u) => u.endsWith('.service'));
  }
  return out;
}

new client.Gauge({
  name: 'ozwell_cgroup_memory_bytes',
  help: 'cgroup v2 memory.current; scope="container" for the whole container, unit=<systemd unit> per service',
  labelNames: ['scope', 'unit'],
  registers: [registry],
  collect() {
    this.reset();
    if (!cgroupRoot) return;
    const total = readNum(join(cgroupRoot, 'memory.current'));
    if (total !== null) this.set({ scope: 'container', unit: '' }, total);
    for (const [u, dir] of unitCgroups(cgroupRoot)) {
      const v = readNum(join(dir, 'memory.current'));
      if (v) this.set({ scope: 'unit', unit: u }, v);
    }
  },
});

new client.Gauge({
  name: 'ozwell_cgroup_memory_peak_bytes',
  help: 'cgroup v2 memory.peak (high-water mark since the cgroup was created)',
  labelNames: ['scope', 'unit'],
  registers: [registry],
  collect() {
    this.reset();
    if (!cgroupRoot) return;
    const total = readNum(join(cgroupRoot, 'memory.peak'));
    if (total !== null) this.set({ scope: 'container', unit: '' }, total);
    for (const [u, dir] of unitCgroups(cgroupRoot)) {
      const v = readNum(join(dir, 'memory.peak'));
      if (v) this.set({ scope: 'unit', unit: u }, v);
    }
  },
});

new client.Gauge({
  name: 'ozwell_cgroup_memory_stat_bytes',
  help: 'Container cgroup memory.stat: anon (process memory; what leaks and OOMs) vs file (page cache, reclaimable)',
  labelNames: ['type'],
  registers: [registry],
  collect() {
    this.reset();
    if (!cgroupRoot) return;
    try {
      const stat = readFileSync(join(cgroupRoot, 'memory.stat'), 'utf8');
      for (const t of ['anon', 'file', 'kernel', 'shmem', 'sock']) {
        const v = new RegExp(`^${t} (\\d+)$`, 'm').exec(stat)?.[1];
        if (v !== undefined) this.set({ type: t }, Number(v));
      }
    } catch { /* ignore */ }
  },
});

new client.Counter({
  name: 'ozwell_cgroup_cpu_seconds_total',
  help: 'CPU time used by the whole container (cgroup v2 cpu.stat usage_usec)',
  registers: [registry],
  collect() {
    this.reset();
    if (!cgroupRoot) return;
    try {
      const usec = /^usage_usec (\d+)$/m.exec(readFileSync(join(cgroupRoot, 'cpu.stat'), 'utf8'))?.[1];
      if (usec) this.inc(Number(usec) / 1e6);
    } catch { /* ignore */ }
  },
});

/** CPUs from a cgroup v2 cpu.max ("<quota> <period>" or "max <period>"), or null when unlimited. */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === 'max' || !Number(quota) || !Number(period)) return null;
  return Number(quota) / Number(period);
}

/** CPUs available: the tightest cpu.max quota on the cgroup or its ancestors, capped by scheduler affinity. */
export function availableCpus(cgroup: string | null, parallelism = availableParallelism()): number {
  const ancestors = (p: string): string[] => (dirname(p) === p ? [p] : [p, ...ancestors(dirname(p))]);
  const quotas = (cgroup ? ancestors(cgroup) : []).map((p) => {
    try {
      return parseCpuMax(readFileSync(join(p, 'cpu.max'), 'utf8'));
    } catch {
      return null; // no cpu controller here (e.g. the namespace root)
    }
  });
  return Math.min(parallelism, ...quotas.filter((q) => q !== null));
}

let cpusOverride: number | undefined;
/** Use an admin-supplied CPU capacity instead of the detected one (config `cpus`). */
export const setCpus = (n: number | undefined) => { cpusOverride = n; };

new client.Gauge({
  name: 'ozwell_cpus',
  help: 'CPUs available to the container (OZWELL_COMPUTER_CPUS, else cgroup v2 cpu.max quota, else scheduler affinity); divide CPU rates by this for a 0-100% figure',
  registers: [registry],
  collect() {
    this.set(cpusOverride ?? availableCpus(cgroupRoot));
  },
});

new client.Gauge({
  name: 'ozwell_cgroup_memory_limit_bytes',
  help: 'cgroup v2 memory.max of the container (absent when unlimited)',
  registers: [registry],
  collect() {
    this.reset();
    const v = cgroupRoot ? readNum(join(cgroupRoot, 'memory.max')) : null;
    if (v !== null) this.set(v);
  },
});

/** Executable name from argv[0] (the comm/Name field can be a thread name like "MainThread"). */
function commandName(pid: string): string | null {
  try {
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
    if (!argv0) return null;
    const base = argv0.split('/').pop()!.split(' ')[0];
    return base.replace(/:$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Per command name: PSS (shared pages split between sharers, so sums are meaningful for
 * multi-process apps like Firefox), RSS, and peak RSS (VmHWM), for processes this user can read.
 */
function processMemory(): Map<string, { pss: number; rss: number; hwm: number; count: number }> {
  const out = new Map<string, { pss: number; rss: number; hwm: number; count: number }>();
  let pids: string[] = [];
  try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const name = commandName(pid) ?? /^Name:\s+(.+)$/m.exec(status)?.[1] ?? '?';
      const rss = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0) * 1024;
      const hwm = Number(/^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0) * 1024;
      if (!rss) continue; // kernel threads
      let pss = rss;
      try { pss = Number(/^Pss:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? rss / 1024) * 1024; } catch { /* keep rss */ }
      const e = out.get(name) ?? { pss: 0, rss: 0, hwm: 0, count: 0 };
      e.pss += pss; e.rss += rss; e.hwm += hwm; e.count++;
      out.set(name, e);
    } catch { /* exited or not readable */ }
  }
  return out;
}

let procCache: { at: number; data: ReturnType<typeof processMemory> } | null = null;
const procMem = () => {
  if (!procCache || Date.now() - procCache.at > 500) procCache = { at: Date.now(), data: processMemory() };
  return procCache.data;
};

new client.Gauge({
  name: 'ozwell_process_pss_bytes', help: 'Proportional set size summed by command name (shared pages split between processes)', labelNames: ['command'], registers: [registry],
  collect() { this.reset(); for (const [k, v] of procMem()) this.set({ command: k }, v.pss); },
});
new client.Gauge({
  name: 'ozwell_process_resident_bytes', help: 'Resident memory summed by command name (double-counts shared pages)', labelNames: ['command'], registers: [registry],
  collect() { this.reset(); for (const [k, v] of procMem()) this.set({ command: k }, v.rss); },
});
new client.Gauge({
  name: 'ozwell_process_resident_peak_bytes', help: 'Peak resident memory (VmHWM) summed by command name', labelNames: ['command'], registers: [registry],
  collect() { this.reset(); for (const [k, v] of procMem()) this.set({ command: k }, v.hwm); },
});
new client.Gauge({
  name: 'ozwell_processes', help: 'Process count by command name', labelNames: ['command'], registers: [registry],
  collect() { this.reset(); for (const [k, v] of procMem()) this.set({ command: k }, v.count); },
});

export async function render(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}
