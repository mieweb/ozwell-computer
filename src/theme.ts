import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { unsupported } from './errors.js';

export type ColorScheme = 'light' | 'dark';
export interface ThemeState { scheme: ColorScheme; set: boolean }

// Greybird ships GTK and xfwm4 themes for both schemes.
const THEME: Record<ColorScheme, string> = { light: 'Greybird', dark: 'Greybird-dark' };
// xfsettingsd serves /Net/ThemeName to GTK apps; xfwm4 follows /general/theme.
const PROPERTIES = [['xsettings', '/Net/ThemeName'], ['xfwm4', '/general/theme']];
// Written once both properties are set, so a choice that failed to apply still counts as unset.
const MARKER = join(homedir(), '.config', 'ozwell-computer', 'color-scheme');
const run = promisify(execFile);

/** The desktop's color scheme; `set` stays false until someone chooses one. */
export async function getTheme(): Promise<ThemeState> {
  const saved = await readFile(MARKER, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (saved === null) return { scheme: 'light', set: false };
  return { scheme: saved.trim() === 'dark' ? 'dark' : 'light', set: true };
}

const missing = (what: string) => (e: NodeJS.ErrnoException) => {
  throw e.code === 'ENOENT' ? unsupported('theme', `${what} is not installed`) : e;
};

// This user's xfsettingsd on `display` (not another display's or user's).
async function xfsettingsdRunning(display: string) {
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
  const comms = await Promise.all(pids.map((p) => readFile(`/proc/${p}/comm`, 'utf8').catch(() => '')));
  const named = pids.filter((_, i) => comms[i].trim() === 'xfsettingsd');
  const ours = await Promise.all(named.map(async (p) => {
    const [st, env] = await Promise.all([stat(`/proc/${p}`), readFile(`/proc/${p}/environ`, 'utf8')]).catch(() => [null, ''] as const);
    return st?.uid === process.getuid?.() && env.split('\0').includes(`DISPLAY=${display}`);
  }));
  return ours.includes(true);
}

// xfconf only stores the theme; xfsettingsd publishes it to GTK apps. The XFCE session starts it,
// but not on a spawned Xvfb, nor after #26's xsettingsd took the XSETTINGS selection first.
async function ensureSettingsDaemon(display: string) {
  if (await xfsettingsdRunning(display)) return;
  await run('xfsettingsd', ['--replace', '--daemon', '--disable-wm-check', '--sm-client-disable'], { env: { ...process.env, DISPLAY: display } })
    .catch(missing('xfsettingsd'));
}

// --create makes the property when no channel default provides it (e.g. --spawn-xvfb hosts).
// allSettled: a failed write must not release the queue while the other is still running.
async function apply(scheme: ColorScheme) {
  const results = await Promise.allSettled(PROPERTIES.map(([channel, property]) =>
    run('xfconf-query', ['-c', channel, '-p', property, '-n', '-t', 'string', '-s', THEME[scheme]]).catch(missing('xfconf-query'))));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

let queue: Promise<unknown> = Promise.resolve();

/** Switch the GTK and window-manager themes live. With onlyIfUnset, an earlier choice wins. */
export function setTheme(scheme: ColorScheme, display: string, onlyIfUnset = false): Promise<ThemeState> {
  const next = queue.then(async (): Promise<ThemeState> => {
    const current = await getTheme();
    if (onlyIfUnset && current.set) return current;
    await ensureSettingsDaemon(display);
    await apply(scheme);
    await mkdir(dirname(MARKER), { recursive: true });
    await writeFile(MARKER, `${scheme}\n`);
    return { scheme, set: true };
  });
  queue = next.catch(() => undefined);
  return next;
}
