// Environment for the admin CLI, prepared before telemetry.ts loads (it reads the
// environment at import). No imports with side effects: bin/admin calls this first.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

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
