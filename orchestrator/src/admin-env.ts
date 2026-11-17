// Environment for the admin CLI, prepared before telemetry.ts loads (it reads the
// environment at import). No imports with side effects: bin/admin calls this first.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { userInfo } from 'node:os';

export const ADMIN_SERVICE_NAME = 'ozwell-computer-admin';

/** Load `envFile` when it exists (variables already set win, like `--env-file`), silently
 * otherwise; then name the CLI's spans ozwell-computer-admin unless OTEL_SERVICE_NAME is set. */
export function prepareAdminEnv(envFile: string | URL, env: NodeJS.ProcessEnv = process.env): void {
  if (existsSync(envFile)) {
    if (env === process.env) process.loadEnvFile(envFile);
    else for (const [k, v] of Object.entries(parseEnvFile(envFile))) env[k] ??= v;
  }
  env.OTEL_SERVICE_NAME ||= ADMIN_SERVICE_NAME;
}

/** Same parser as process.loadEnvFile, for an env object other than process.env (tests). */
function parseEnvFile(file: string | URL): Record<string, string> {
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

/** Remove `--operator <name>` / `--operator=<name>` (accepted anywhere) from argv. */
export function takeOperator(argv: string[]): { argv: string[]; operator?: string } {
  const rest: string[] = [];
  let operator: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--operator') operator = argv[++i];
    else if (a.startsWith('--operator=')) operator = a.slice('--operator='.length);
    else rest.push(a);
  }
  return { argv: rest, operator: operator || undefined };
}

/** Who ran the command, for the audit log: --operator, OZWELL_ADMIN_OPERATOR, the sudo
 * caller, $USER, the OS account name, else the uid. Never null (compose exec has no $USER). */
export function resolveOperator(env: NodeJS.ProcessEnv, flag?: string, os: () => { username: string; uid: number } = userInfo): string {
  const named = flag || env.OZWELL_ADMIN_OPERATOR || env.SUDO_USER || env.USER;
  if (named) return named;
  try {
    const u = os();
    return u.username || `uid:${u.uid}`;
  } catch {
    return typeof process.getuid === 'function' ? `uid:${process.getuid()}` : 'unknown';
  }
}
