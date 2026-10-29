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
  const display = ':4242';
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

  it('fails as unsupported without xfsettingsd or xfconf-query', async () => {
    const { getTheme, setTheme } = await theme();
    await expect(setTheme('dark', display, true)).rejects.toThrow(/xfsettingsd is not installed/);
    writeFileSync(join(bin, 'xfsettingsd'), `#!/bin/sh\necho "$DISPLAY $*" >> '${join(home, 'daemon')}'\n`, { mode: 0o755 });
    await expect(setTheme('dark', display, true)).rejects.toThrow(/xfconf-query is not installed/);
    expect(await getTheme()).toEqual({ scheme: 'light', set: false });
  });

  it('starts xfsettingsd on the display when none serves it, replacing any other XSETTINGS daemon', () => {
    expect(readFileSync(join(home, 'daemon'), 'utf8')).toMatch(/^:4242 --replace --daemon /m);
  });

  it('fails when xfsettingsd exits without forking', async () => {
    const daemon = readFileSync(join(bin, 'xfsettingsd'), 'utf8');
    writeFileSync(join(bin, 'xfsettingsd'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const { setTheme } = await theme();
    await expect(setTheme('dark', display, true)).rejects.toThrow(/xfsettingsd did not start \(exit code 1\)/);
    writeFileSync(join(bin, 'xfsettingsd'), daemon, { mode: 0o755 });
  });

  it('records nothing when xfconf-query fails, so if_unset retries', async () => {
    const { getTheme, setTheme } = await theme();
    fake(1);
    await expect(setTheme('dark', display, true)).rejects.toThrow(/xfconf-query/);
    expect(await getTheme()).toEqual({ scheme: 'light', set: false });
    rmSync(calls);
    fake(0);
    expect(await setTheme('dark', display, true)).toEqual({ scheme: 'dark', set: true });
    expect(await getTheme()).toEqual({ scheme: 'dark', set: true });
  });

  it('sets the GTK and xfwm4 themes to Greybird-dark / Greybird', async () => {
    expect(recorded()).toEqual([
      '-c xfwm4 -p /general/theme -n -t string -s Greybird-dark',
      '-c xsettings -p /Net/ThemeName -n -t string -s Greybird-dark',
    ]);
    rmSync(calls);
    const { getTheme, setTheme } = await theme();
    expect(await setTheme('light', display)).toEqual({ scheme: 'light', set: true });
    expect(recorded()).toEqual([
      '-c xfwm4 -p /general/theme -n -t string -s Greybird',
      '-c xsettings -p /Net/ThemeName -n -t string -s Greybird',
    ]);
    expect(await getTheme()).toEqual({ scheme: 'light', set: true });
  });

  it('keeps an earlier choice with if_unset', async () => {
    rmSync(calls);
    const { setTheme } = await theme();
    expect(await setTheme('dark', display, true)).toEqual({ scheme: 'light', set: true });
    expect(() => readFileSync(calls)).toThrow(/ENOENT/);
  });

  it('a failed switch settles both writes before the next one starts', async () => {
    const { setTheme } = await theme();
    // Dark: the xsettings write fails at once while the xfwm4 write is still running.
    writeFileSync(join(bin, 'xfconf-query'), `#!/bin/sh
case "$*" in *xsettings*-dark) exit 1 ;; *xfwm4*-dark) /bin/sleep 0.3 ;; esac
echo "$*" >> '${calls}'
`, { mode: 0o755 });
    const failed = setTheme('dark', display);
    const retry = setTheme('light', display);
    await expect(failed).rejects.toThrow();
    await retry;
    expect(readFileSync(calls, 'utf8').trim().split('\n').at(-1)).toMatch(/-s Greybird$/);
  });
});
