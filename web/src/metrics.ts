// Toolbar metrics from the Prometheus endpoint; pure so unit tests can import it.

export type Metrics = { cpu?: number; cpus?: number; mem?: number; limit?: number; vnc?: number };
export type Sample = Metrics & { t: number };

/** The few series the toolbar shows, from Prometheus text format. */
export function readMetrics(text: string): Metrics {
  const out: Metrics = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^(\w+)(\{[^}]*\})? (\S+)$/.exec(line);
    if (!m) continue;
    const [, name, labels = '', value] = m;
    const v = Number(value);
    if (name === 'ozwell_cgroup_cpu_seconds_total') out.cpu = v;
    else if (name === 'ozwell_cpus') out.cpus = v;
    else if (name === 'ozwell_cgroup_memory_bytes' && labels.includes('scope="container"')) out.mem = v;
    else if (name === 'ozwell_cgroup_memory_limit_bytes') out.limit = v;
    else if (name === 'ozwell_vnc_sent_bytes_total') out.vnc = v;
  }
  return out;
}

/** CPU use between two samples as 0-100% of the available CPUs (older servers lack ozwell_cpus: 1 CPU). */
export function cpuPercent(prev: { cpu: number; t: number }, now: { cpu: number; t: number; cpus?: number }): number {
  const pct = ((now.cpu - prev.cpu) / ((now.t - prev.t) / 1000) / (now.cpus || 1)) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Tooltip for the toolbar readout, naming the CPU count when the server reports it. */
export function perfTitle(cpus?: number): string {
  const base = 'Container resource use (from /api/v1/metrics)';
  return cpus ? `${base}; CPU is % of ${+cpus.toFixed(2)} CPU${cpus === 1 ? '' : 's'}` : base;
}
