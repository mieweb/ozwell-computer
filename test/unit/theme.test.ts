import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

describe('desktop theme', () => {
  const home = mkdtempSync(join(tmpdir(), 'oz-theme-'));
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  afterAll(() => {
    Object.assign(process.env, env);
    rmSync(home, { recursive: true, force: true });
  });

  it('rolls back a choice that could not be applied, so if_unset can retry', async () => {
    // No xsettingsd on PATH, and a display nothing serves.
    Object.assign(process.env, { HOME: home, PATH: home });
    const { getTheme, setTheme } = await import('../../src/theme.js');
    writeFileSync(join(home, '.xsettingsd'), 'Gtk/FontName "Sans 10"\n');
    await expect(setTheme('dark', ':4242', true)).rejects.toMatchObject({ reason: 'feature_unsupported' });
    expect(readFileSync(join(home, '.xsettingsd'), 'utf8')).toBe('Gtk/FontName "Sans 10"\n');
    expect(await getTheme()).toEqual({ scheme: 'light', set: false });
  });

  it('treats an xsettingsd that exits right after launch as a failure and rolls back', async () => {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'xsettingsd'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${env.PATH}`;
    const { getTheme, setTheme } = await import('../../src/theme.js');
    await expect(setTheme('dark', ':4242', true)).rejects.toThrow(/exited during startup/);
    expect(await getTheme()).toEqual({ scheme: 'light', set: false });
  });
});
