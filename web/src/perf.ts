// The toolbar's resource readout, as plain data so it can be unit-tested without a DOM.
export type Metrics = { cpu?: number; mem?: number; limit?: number; vnc?: number };
export type Sample = Metrics & { t: number };
/** One readout field; `value` is undefined while it shows a placeholder, `width` is in ch. `limit` (Mem
 * only) is a second fixed-width value: undefined until known, null when there is none. */
export type Part = { label: string; value?: string; unit: string; width: number; hot?: boolean; limit?: string | null };

const MiB = (b: number) => Math.round(b / 2 ** 20);

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
    else if (name === 'ozwell_cgroup_memory_bytes' && labels.includes('scope="container"')) out.mem = v;
    else if (name === 'ozwell_cgroup_memory_limit_bytes') out.limit = v;
    else if (name === 'ozwell_vnc_sent_bytes_total') out.vnc = v;
  }
  return out;
}

const rate = (prev: Sample, now: Sample, key: 'cpu' | 'vnc') => {
  const a = prev[key], b = now[key];
  return a === undefined || b === undefined ? undefined : (b - a) / ((now.t - prev.t) / 1000);
};

/** The readout for two samples, or the same layout with placeholders until there is a pair. `limit` is
 * the memory limit in bytes, null without one, or undefined before the first sample. */
export function perfParts(prev: Sample | null, now: Sample | null, limit: number | null | undefined): Part[] {
  // Rates need two samples, so every value waits for the second one.
  const pair = prev && now ? { cpu: rate(prev, now, 'cpu'), vnc: rate(prev, now, 'vnc'), mem: now.mem } : {};
  const { cpu, vnc, mem } = pair;
  const kbs = vnc === undefined ? undefined : vnc / 1024;
  const mbs = kbs !== undefined && kbs >= 1024;
  return [
    { label: 'CPU', value: cpu === undefined ? undefined : Math.max(0, cpu * 100).toFixed(0), unit: '%', width: 3, hot: cpu !== undefined && cpu > 0.8 },
    {
      label: 'Mem',
      value: mem === undefined ? undefined : String(MiB(mem)),
      unit: ' MiB',
      width: 5,
      hot: mem !== undefined && !!limit && mem / limit > 0.85,
      limit: limit === null ? null : limit === undefined || mem === undefined ? undefined : String(MiB(limit)),
    },
    { label: 'VNC', value: kbs === undefined ? undefined : mbs ? (kbs / 1024).toFixed(1) : kbs.toFixed(0), unit: mbs ? ' MB/s' : ' KB/s', width: 4 },
  ];
}

export const PLACEHOLDER = '–';

export const perfText = (parts: Part[]) => parts.map((p) =>
  `${p.label} ${p.value ?? PLACEHOLDER}${p.unit}${'limit' in p && p.limit !== null ? ` / ${p.limit ?? PLACEHOLDER} MiB` : ''}`).join(' · ');
