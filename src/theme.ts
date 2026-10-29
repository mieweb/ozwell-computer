import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

// --create makes the property when no channel default provides it (e.g. --spawn-xvfb hosts).
const apply = (scheme: ColorScheme) => Promise.all(PROPERTIES.map(([channel, property]) =>
  run('xfconf-query', ['-c', channel, '-p', property, '-n', '-t', 'string', '-s', THEME[scheme]])
    .catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' ? unsupported('theme', 'xfconf-query is not installed') : e;
    })));

let queue: Promise<unknown> = Promise.resolve();

/** Switch the GTK and window-manager themes live. With onlyIfUnset, an earlier choice wins. */
export function setTheme(scheme: ColorScheme, onlyIfUnset = false): Promise<ThemeState> {
  const next = queue.then(async (): Promise<ThemeState> => {
    const current = await getTheme();
    if (onlyIfUnset && current.set) return current;
    await apply(scheme);
    await mkdir(dirname(MARKER), { recursive: true });
    await writeFile(MARKER, `${scheme}\n`);
    return { scheme, set: true };
  });
  queue = next.catch(() => undefined);
  return next;
}
