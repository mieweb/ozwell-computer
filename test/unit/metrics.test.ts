import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { availableCpus, parseCpuMax, render, setCpus } from '../../src/metrics.js';
import { cpuPercent, perfTitle, readMetrics } from '../../web/src/metrics.js';

describe('cpu count', () => {
  it('parses cgroup v2 cpu.max', () => {
    expect(parseCpuMax('max 100000\n')).toBeNull();
    expect(parseCpuMax('200000 100000\n')).toBe(2);
    expect(parseCpuMax('150000 100000')).toBe(1.5);
  });

  it('uses the tightest quota on the cgroup or its ancestors, capped by affinity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ozwell-cg-'));
    const leaf = join(root, 'lxc', 'ct');
    mkdirSync(leaf, { recursive: true });
    expect(availableCpus(leaf, 8)).toBe(8);
    writeFileSync(join(leaf, 'cpu.max'), 'max 100000\n');
    expect(availableCpus(leaf, 8)).toBe(8);
    writeFileSync(join(root, 'lxc', 'cpu.max'), '300000 100000\n');
    expect(availableCpus(leaf, 8)).toBe(3);
    writeFileSync(join(leaf, 'cpu.max'), '50000 100000\n');
    expect(availableCpus(leaf, 8)).toBe(0.5);
    expect(availableCpus(leaf, 0.25)).toBe(0.25);
    expect(availableCpus(null, 4)).toBe(4);
  });

  it('exports ozwell_cpus, or the configured override', async () => {
    expect(readMetrics((await render()).body).cpus).toBeGreaterThan(0);
    setCpus(2.5);
    expect(readMetrics((await render()).body).cpus).toBe(2.5);
    setCpus(undefined);
  });
});

describe('toolbar cpu percent', () => {
  it('normalizes by available CPUs and clamps to 0-100', () => {
    expect(cpuPercent({ cpu: 0, t: 0 }, { cpu: 3, t: 1000, cpus: 4 })).toBe(75);
    expect(cpuPercent({ cpu: 0, t: 0 }, { cpu: 5, t: 1000, cpus: 4 })).toBe(100);
    expect(cpuPercent({ cpu: 5, t: 0 }, { cpu: 0, t: 1000, cpus: 4 })).toBe(0);
    expect(cpuPercent({ cpu: 0, t: 0 }, { cpu: 0.5, t: 1000 })).toBe(50);
  });

  it('names the CPU count in the tooltip', () => {
    expect(perfTitle(4)).toMatch(/CPU is % of 4 CPUs$/);
    expect(perfTitle(1)).toMatch(/CPU is % of 1 CPU$/);
    expect(perfTitle()).not.toContain('CPU is');
  });
});
