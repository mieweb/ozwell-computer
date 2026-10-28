import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export function inContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv') || process.env.container !== undefined;
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const ConfigSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535),
  host: z.string(),
  token: z.string().min(1).optional(),
  tokenFile: z.string(),
  authDisabled: bool,
  display: z.string(),
  spawnXvfb: bool,
  screen: z.string().regex(/^\d+x\d+(x\d+)?$/),
  viewOnly: bool,
  a11y: z.enum(['auto', 'on', 'off']),
  exec: bool,
  vncBackend: z.string().regex(/^(builtin|external:(?:[\w.-]+:)?\d+)$/),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  /** Optional root for the filesystem API; defaults to "/" (whole FS as the service user). */
  fsRoot: z.string(),
  /** Externally visible base URL for the startup link (e.g. the host port behind Docker). */
  publicUrl: z.string().url().optional(),
  /** APT `Packages` index to check for new releases; "off" disables update checks. */
  updateUrl: z.string().refine((v) => v === 'off' || /^(https?|file):\/\//.test(v), 'must be a URL or "off"'),
  /** Open the viewer in the default browser once listening. */
  open: bool,
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaults(): Config {
  const container = inContainer();
  return {
    port: 8080,
    host: container ? '0.0.0.0' : '127.0.0.1',
    token: undefined,
    tokenFile: container ? '/var/lib/ozwell-desktop/token' : join(homedir(), '.config', 'ozwell-desktop', 'token'),
    authDisabled: false,
    display: process.env.DISPLAY || ':0',
    spawnXvfb: false,
    screen: '1920x1080x24',
    viewOnly: false,
    a11y: 'auto',
    exec: true,
    vncBackend: 'builtin',
    logLevel: 'info',
    fsRoot: '/',
    publicUrl: undefined,
    updateUrl: 'https://github.com/mieweb/ozwell-desktop/releases/latest/download/Packages',
    open: false,
  };
}

const ENV_MAP: Record<string, keyof Config> = {
  OZWELL_DESKTOP_PORT: 'port',
  OZWELL_DESKTOP_HOST: 'host',
  OZWELL_DESKTOP_TOKEN: 'token',
  OZWELL_DESKTOP_TOKEN_FILE: 'tokenFile',
  OZWELL_DESKTOP_AUTH_DISABLED: 'authDisabled',
  DISPLAY: 'display',
  OZWELL_DESKTOP_SPAWN_XVFB: 'spawnXvfb',
  OZWELL_DESKTOP_SCREEN: 'screen',
  OZWELL_DESKTOP_VIEW_ONLY: 'viewOnly',
  OZWELL_DESKTOP_A11Y: 'a11y',
  OZWELL_DESKTOP_EXEC: 'exec',
  OZWELL_DESKTOP_VNC_BACKEND: 'vncBackend',
  OZWELL_DESKTOP_LOG_LEVEL: 'logLevel',
  OZWELL_DESKTOP_FS_ROOT: 'fsRoot',
  OZWELL_DESKTOP_PUBLIC_URL: 'publicUrl',
  OZWELL_DESKTOP_UPDATE_URL: 'updateUrl',
  OZWELL_DESKTOP_OPEN: 'open',
};

const FLAG_MAP: Record<string, keyof Config> = {
  port: 'port',
  host: 'host',
  token: 'token',
  'token-file': 'tokenFile',
  'auth-disabled': 'authDisabled',
  'no-auth': 'authDisabled',
  display: 'display',
  'spawn-xvfb': 'spawnXvfb',
  screen: 'screen',
  'view-only': 'viewOnly',
  a11y: 'a11y',
  exec: 'exec',
  'no-exec': 'exec',
  'vnc-backend': 'vncBackend',
  'log-level': 'logLevel',
  'fs-root': 'fsRoot',
  'public-url': 'publicUrl',
  'update-url': 'updateUrl',
  open: 'open',
};

const BOOLEAN_FLAGS = new Set(['auth-disabled', 'no-auth', 'spawn-xvfb', 'view-only', 'exec', 'no-exec', 'open']);

export interface ParsedArgs {
  overrides: Partial<Record<keyof Config, unknown>>;
  printOpenapi: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<Record<keyof Config, unknown>> = {};
  let printOpenapi = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print-openapi') { printOpenapi = true; continue; }
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '-v' || a === '--version') { version = true; continue; }
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    let [name, value] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const key = FLAG_MAP[name];
    if (!key) throw new Error(`unknown flag: --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      const v = value === undefined ? true : bool.parse(value);
      overrides[key] = name.startsWith('no-') && name !== 'no-auth' ? !v : v;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`--${name} requires a value`);
    }
    overrides[key] = value;
  }
  return { overrides, printOpenapi, help, version };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = []): { config: Config; args: ParsedArgs } {
  const args = parseArgs(argv);
  const merged: Record<string, unknown> = { ...defaults() };
  for (const [envName, key] of Object.entries(ENV_MAP)) {
    const v = env[envName];
    if (v !== undefined && v !== '') merged[key] = v;
  }
  Object.assign(merged, args.overrides);
  const config = ConfigSchema.parse(merged);
  return { config, args };
}

export const HELP = `ozwell-desktop — X11 desktop over HTTP (noVNC + API + MCP)

Usage: ozwell-desktop [flags]

  --port <n>              OZWELL_DESKTOP_PORT (8080)
  --host <addr>           OZWELL_DESKTOP_HOST (127.0.0.1 on host, 0.0.0.0 in container)
  --token <psk>           OZWELL_DESKTOP_TOKEN
  --token-file <path>     OZWELL_DESKTOP_TOKEN_FILE
  --no-auth               OZWELL_DESKTOP_AUTH_DISABLED=true
  --display <:n>          DISPLAY
  --spawn-xvfb            OZWELL_DESKTOP_SPAWN_XVFB=true (development)
  --screen <WxHxD>        OZWELL_DESKTOP_SCREEN (1920x1080x24)
  --view-only             OZWELL_DESKTOP_VIEW_ONLY=true
  --a11y <auto|on|off>    OZWELL_DESKTOP_A11Y
  --no-exec               OZWELL_DESKTOP_EXEC=false
  --vnc-backend <b>       OZWELL_DESKTOP_VNC_BACKEND (builtin | external:[host:]port)
  --log-level <lvl>       OZWELL_DESKTOP_LOG_LEVEL (info)
  --fs-root <dir>         OZWELL_DESKTOP_FS_ROOT (/)
  --public-url <url>      OZWELL_DESKTOP_PUBLIC_URL: base URL shown in the startup link
  --update-url <url|off>  OZWELL_DESKTOP_UPDATE_URL: APT Packages index checked for new releases
  --open                  OZWELL_DESKTOP_OPEN=true: open the viewer in the default browser
  --print-openapi         Print the OpenAPI document and exit
`;
