import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('desktop theme', () => {
  const home = mkdtempSync(join(tmpdir(), 'oz-theme-'));
  const bin = join(home, 'bin');
  const calls = join(home, 'calls');
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  // A fake xfconf-query that records its arguments and exits with `code`.
  const fake = (code: number) => writeFileSync(join(bin, 'xfconf-query'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit ${code}\n`, { mode: 0o755 });
  const recorded = () => readFileSync(calls, 'utf8').trim().split('\n').sort();
  const theme = () => import('../../src/theme.js');
  // Before any test imports src/theme.ts, which resolves the marker under HOME at load.
  beforeAll(() => {
    process.env.HOME = home;
    process.env.PATH = bin;
    mkdirSync(bin);
  });
  afterAll(() => {
    Object.assign(process.env, env);
    rmSync(home, { recursive: true, force: true });
  });

  it('fails as unsupported without xfconf-query', async () => {
    const { getTheme, setTheme } = await theme();
    await expect(setTheme('dark', true)).rejects.toMatchObject({ reason: 'feature_unsupported' });
    expect(await getTheme()).toEqual({ scheme: 'light', set: false });
  });

  it('records nothing when xfconf-query fails, so if_unset retries', async () => {
    const { getTheme, setTheme } = await theme();
    fake(1);
    await expect(setTheme('dark', true)).rejects.toThrow(/xfconf-query/);
    expect(await getTheme()).toEqual({ scheme: 'light', set: false });
    rmSync(calls);
    fake(0);
    expect(await setTheme('dark', true)).toEqual({ scheme: 'dark', set: true });
    expect(await getTheme()).toEqual({ scheme: 'dark', set: true });
  });

  it('sets the GTK and xfwm4 themes to Greybird-dark / Greybird', async () => {
    expect(recorded()).toEqual([
      '-c xfwm4 -p /general/theme -n -t string -s Greybird-dark',
      '-c xsettings -p /Net/ThemeName -n -t string -s Greybird-dark',
    ]);
    rmSync(calls);
    const { getTheme, setTheme } = await theme();
    expect(await setTheme('light')).toEqual({ scheme: 'light', set: true });
    expect(recorded()).toEqual([
      '-c xfwm4 -p /general/theme -n -t string -s Greybird',
      '-c xsettings -p /Net/ThemeName -n -t string -s Greybird',
    ]);
    expect(await getTheme()).toEqual({ scheme: 'light', set: true });
  });

  it('keeps an earlier choice with if_unset', async () => {
    rmSync(calls);
    const { setTheme } = await theme();
    expect(await setTheme('dark', true)).toEqual({ scheme: 'light', set: true });
    expect(() => readFileSync(calls)).toThrow(/ENOENT/);
  });
});
