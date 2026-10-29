import { describe, expect, it } from 'vitest';
import { perfParts, perfText } from '../../web/src/perf.js';

describe('perfParts', () => {
  it('shows placeholders in the full layout before there are two samples', () => {
    expect(perfText(perfParts(null, null))).toBe('CPU –% · Mem – MiB · VNC – KB/s');
    expect(perfText(perfParts(null, { mem: 2 ** 30, limit: 2 ** 31, t: 0 }))).toBe('CPU –% · Mem – MiB / 2048 MiB · VNC – KB/s');
  });

  it('shows every value once there are two samples', () => {
    const prev = { cpu: 10, vnc: 0, mem: 2 ** 29, t: 0 };
    const now = { cpu: 10.5, vnc: 2048 * 1024, mem: 2 ** 30, t: 1000 };
    const out = perfText(perfParts(prev, now));
    expect(out).toBe('CPU 50% · Mem 1024 MiB · VNC 2.0 MB/s');
    expect(out).toMatch(/CPU \d+%.*Mem \d+ MiB/);
  });

  it('flags high CPU and memory use', () => {
    const parts = perfParts({ cpu: 0, t: 0 }, { cpu: 0.9, mem: 9, limit: 10, t: 1000 });
    expect(parts.map((p) => !!p.hot)).toEqual([true, true, false]);
  });
});
