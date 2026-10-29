import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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

async function xsettingsdPids() {
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
  const comms = await Promise.all(pids.map((p) => readFile(`/proc/${p}/comm`, 'utf8').catch(() => '')));
  return pids.filter((_, i) => comms[i].trim() === 'xsettingsd').map(Number);
}

// SIGHUP makes xsettingsd reload its config; start it if the session hasn't (older sessions, --spawn-xvfb).
async function reload(display: string) {
  const pids = await xsettingsdPids();
  pids.forEach((p) => process.kill(p, 'SIGHUP'));
  if (pids.length) return;
  const child = spawn('xsettingsd', [], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
  await once(child, 'spawn').catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'ENOENT' ? unsupported('theme', 'xsettingsd is not installed') : e;
  });
  child.unref();
}

let queue: Promise<unknown> = Promise.resolve();

/** Switch the GTK theme live. With onlyIfUnset, an earlier choice wins. */
export function setTheme(scheme: ColorScheme, display: string, onlyIfUnset = false): Promise<ThemeState> {
  const next = queue.then(async (): Promise<ThemeState> => {
    const current = await getTheme();
    if (onlyIfUnset && current.set) return current;
    const kept = ((await readConf()) ?? '').split('\n').filter((l) => l && !THEME_LINE.test(l));
    await writeFile(CONF, [...kept, `Net/ThemeName "${GTK_THEME[scheme]}"`, 'Net/IconThemeName "Adwaita"', ''].join('\n'));
    await reload(display);
    return { scheme, set: true };
  });
  queue = next.catch(() => undefined);
  return next;
}
