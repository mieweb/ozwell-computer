import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isGitUpdateUrl } from './update.js';

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
  /** APT `Packages` index, or git+https://<repo>#<branch> to build a branch, to check for updates; "off" disables. */
  updateUrl: z.string().refine((v) => v === 'off' || /^(https?|file):\/\//.test(v) || isGitUpdateUrl(v), 'must be a URL, git+https://<repo>#<branch>, or "off"'),
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
    tokenFile: container ? '/var/lib/ozwell-computer/token' : join(homedir(), '.config', 'ozwell-computer', 'token'),
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
    updateUrl: 'https://github.com/mieweb/ozwell-computer/releases/latest/download/Packages',
    open: false,
  };
}

const ENV_MAP: Record<string, keyof Config> = {
  OZWELL_COMPUTER_PORT: 'port',
  OZWELL_COMPUTER_HOST: 'host',
  OZWELL_COMPUTER_TOKEN: 'token',
  OZWELL_COMPUTER_TOKEN_FILE: 'tokenFile',
  OZWELL_COMPUTER_AUTH_DISABLED: 'authDisabled',
  DISPLAY: 'display',
  OZWELL_COMPUTER_SPAWN_XVFB: 'spawnXvfb',
  OZWELL_COMPUTER_SCREEN: 'screen',
  OZWELL_COMPUTER_VIEW_ONLY: 'viewOnly',
  OZWELL_COMPUTER_A11Y: 'a11y',
  OZWELL_COMPUTER_EXEC: 'exec',
  OZWELL_COMPUTER_VNC_BACKEND: 'vncBackend',
  OZWELL_COMPUTER_LOG_LEVEL: 'logLevel',
  OZWELL_COMPUTER_FS_ROOT: 'fsRoot',
  OZWELL_COMPUTER_PUBLIC_URL: 'publicUrl',
  OZWELL_COMPUTER_UPDATE_URL: 'updateUrl',
  OZWELL_COMPUTER_OPEN: 'open',
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
  printMcpTools: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<Record<keyof Config, unknown>> = {};
  let printOpenapi = false;
  let printMcpTools = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print-openapi') { printOpenapi = true; continue; }
    if (a === '--print-mcp-tools') { printMcpTools = true; continue; }
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
  return { overrides, printOpenapi, printMcpTools, help, version };
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

export const HELP = `ozwell-computer — X11 desktop over HTTP (noVNC + API + MCP)

Usage: ozwell-computer [flags]

  --port <n>              OZWELL_COMPUTER_PORT (8080)
  --host <addr>           OZWELL_COMPUTER_HOST (127.0.0.1 on host, 0.0.0.0 in container)
  --token <psk>           OZWELL_COMPUTER_TOKEN
  --token-file <path>     OZWELL_COMPUTER_TOKEN_FILE
  --no-auth               OZWELL_COMPUTER_AUTH_DISABLED=true
  --display <:n>          DISPLAY
  --spawn-xvfb            OZWELL_COMPUTER_SPAWN_XVFB=true (development)
  --screen <WxHxD>        OZWELL_COMPUTER_SCREEN (1920x1080x24)
  --view-only             OZWELL_COMPUTER_VIEW_ONLY=true
  --a11y <auto|on|off>    OZWELL_COMPUTER_A11Y
  --no-exec               OZWELL_COMPUTER_EXEC=false
  --vnc-backend <b>       OZWELL_COMPUTER_VNC_BACKEND (builtin | external:[host:]port)
  --log-level <lvl>       OZWELL_COMPUTER_LOG_LEVEL (info)
  --fs-root <dir>         OZWELL_COMPUTER_FS_ROOT (/)
  --public-url <url>      OZWELL_COMPUTER_PUBLIC_URL: base URL shown in the startup link
  --update-url <url|off>  OZWELL_COMPUTER_UPDATE_URL: APT Packages index, or git+https://<repo>#<branch>, checked for updates
  --open                  OZWELL_COMPUTER_OPEN=true: open the viewer in the default browser
  --print-openapi         Print the OpenAPI document and exit
  --print-mcp-tools       Print the MCP tool catalog (name, description, input schema) and exit
`;
