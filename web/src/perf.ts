// The toolbar's resource readout, as plain data so it can be unit-tested without a DOM.
import { cpuPercent, type Sample } from './metrics.js';

/** One readout field; `value` is undefined while it shows a placeholder, `width` is in ch. `limit` (Mem
 * only) is a second fixed-width value: undefined until known, null when there is none. */
export type Part = { label: string; value?: string; unit: string; width: number; hot?: boolean; limit?: string | null };

const MiB = (b: number) => Math.round(b / 2 ** 20);

const rate = (prev: Sample, now: Sample, key: 'vnc') => {
  const a = prev[key], b = now[key];
  return a === undefined || b === undefined ? undefined : (b - a) / ((now.t - prev.t) / 1000);
};

/** The readout for two samples, or the same layout with placeholders until there is a pair. `limit` is
 * the memory limit in bytes, null without one, or undefined before the first sample. */
export function perfParts(prev: Sample | null, now: Sample | null, limit: number | null | undefined): Part[] {
  // Rates need two samples, so every value waits for the second one.
  const cpuOf = (a: Sample, b: Sample) =>
    a.cpu === undefined || b.cpu === undefined ? undefined : cpuPercent({ cpu: a.cpu, t: a.t }, { cpu: b.cpu, t: b.t, cpus: b.cpus });
  const pair = prev && now ? { cpu: cpuOf(prev, now), vnc: rate(prev, now, 'vnc'), mem: now.mem } : {};
  const { cpu, vnc, mem } = pair;
  const kbs = vnc === undefined ? undefined : vnc / 1024;
  const mbs = kbs !== undefined && kbs >= 1024;
  return [
    { label: 'CPU', value: cpu?.toFixed(0), unit: '%', width: 3, hot: cpu !== undefined && cpu > 80 },
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
