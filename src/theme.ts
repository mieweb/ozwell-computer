import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unsupported } from './errors.js';

export type ColorScheme = 'light' | 'dark';
export interface ThemeState { scheme: ColorScheme; set: boolean }

const GTK_THEME: Record<ColorScheme, string> = { light: 'Adwaita', dark: 'Adwaita-dark' };
// xsettingsd's config; the session starts xsettingsd, which serves it to GTK apps over XSETTINGS.
const CONF = join(homedir(), '.xsettingsd');
const THEME_LINE = /^Net\/(ThemeName|IconThemeName)\s/;

const readConf = () => readFile(CONF, 'utf8').catch((e: NodeJS.ErrnoException) => {
  if (e.code === 'ENOENT') return null;
  throw e;
});

/** The desktop's color scheme; `set` stays false until someone chooses one. */
export async function getTheme(): Promise<ThemeState> {
  const conf = await readConf();
  const theme = conf?.split('\n').find((l) => l.startsWith('Net/ThemeName'));
  return { scheme: theme?.includes('-dark"') ? 'dark' : 'light', set: !!theme };
}

// Only this user's daemons serving `display`: another display's would take the signal
// instead, and another user's would fail with EPERM.
async function xsettingsdPids(display: string) {
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
  const comms = await Promise.all(pids.map((p) => readFile(`/proc/${p}/comm`, 'utf8').catch(() => '')));
  const named = pids.filter((_, i) => comms[i].trim() === 'xsettingsd');
  const ours = await Promise.all(named.map(async (p) => {
    const [st, env] = await Promise.all([stat(`/proc/${p}`), readFile(`/proc/${p}/environ`, 'utf8')]).catch(() => [null, ''] as const);
    return st?.uid === process.getuid?.() && env.split('\0').includes(`DISPLAY=${display}`);
  }));
  return named.filter((_, i) => ours[i]).map(Number);
}

async function startDaemon(display: string) {
  const child = spawn('xsettingsd', [], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
  await once(child, 'spawn').catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'ENOENT' ? unsupported('theme', 'xsettingsd is not installed') : e;
  });
  // It exits at once when it can't open the display or take the XSETTINGS selection.
  const exited = await Promise.race([once(child, 'exit').then(([code, sig]) => sig ?? `code ${code}`), sleep(500, null)]);
  if (exited) throw new Error(`xsettingsd exited during startup (${exited})`);
  child.unref();
}

// SIGHUP makes xsettingsd reload its config; start it if the session hasn't (older sessions, --spawn-xvfb).
async function reload(display: string) {
  const pids = await xsettingsdPids(display);
  if (!pids.length) return startDaemon(display);
  pids.forEach((p) => process.kill(p, 'SIGHUP'));
}

/** Serve a saved theme on a display the server started itself; the desktop session starts its own daemon. */
export async function startSettingsDaemon(display: string) {
  if (!(await readConf()) || (await xsettingsdPids(display)).length) return;
  await startDaemon(display);
}

let queue: Promise<unknown> = Promise.resolve();

/** Switch the GTK theme live. With onlyIfUnset, an earlier choice wins. */
export function setTheme(scheme: ColorScheme, display: string, onlyIfUnset = false): Promise<ThemeState> {
  const next = queue.then(async (): Promise<ThemeState> => {
    const current = await getTheme();
    if (onlyIfUnset && current.set) return current;
    const before = await readConf();
    const kept = (before ?? '').split('\n').filter((l) => l && !THEME_LINE.test(l));
    await writeFile(CONF, [...kept, `Net/ThemeName "${GTK_THEME[scheme]}"`, 'Net/IconThemeName "Adwaita"', ''].join('\n'));
    // Undo a choice that never applied, so it doesn't count as set and if_unset can retry.
    await reload(display).catch(async (e) => {
      await (before === null ? rm(CONF, { force: true }) : writeFile(CONF, before));
      throw e;
    });
    return { scheme, set: true };
  });
  queue = next.catch(() => undefined);
  return next;
}
