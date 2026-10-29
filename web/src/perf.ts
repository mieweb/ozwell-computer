// The toolbar's resource readout, as plain data so it can be unit-tested without a DOM.
import { cpuPercent, type Sample } from './metrics.js';

export type Part = { text: string; hot?: boolean };

const PLACEHOLDER = '–';

const MiB = (b: number) => `${Math.round(b / 2 ** 20)} MiB`;

/** The readout for the latest samples; the CPU and VNC rates need two, so they show a placeholder until then. */
export function perfParts(prev: Sample | null, now: Sample | null): Part[] {
  const cpu = prev?.cpu !== undefined && now?.cpu !== undefined
    ? cpuPercent({ cpu: prev.cpu, t: prev.t }, { cpu: now.cpu, t: now.t, cpus: now.cpus }) : undefined;
  const kbs = prev?.vnc !== undefined && now?.vnc !== undefined ? (now.vnc - prev.vnc) / ((now.t - prev.t) / 1000) / 1024 : undefined;
  const mem = now?.mem;
  const limit = now?.limit;
  return [
    { text: `CPU ${cpu?.toFixed(0) ?? PLACEHOLDER}%`, hot: cpu !== undefined && cpu > 80 },
    { text: `Mem ${mem === undefined ? `${PLACEHOLDER} MiB` : MiB(mem)}${limit ? ` / ${MiB(limit)}` : ''}`, hot: mem !== undefined && !!limit && mem / limit > 0.85 },
    { text: `VNC ${kbs === undefined ? `${PLACEHOLDER} KB/s` : kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(0)} KB/s`}` },
  ];
}

export const perfText = (parts: Part[]) => parts.map((p) => p.text).join(' · ');
