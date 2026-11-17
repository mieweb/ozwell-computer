import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAdminEnv, ADMIN_SERVICE_NAME } from '../src/admin-env.ts';
import { telemetryConfig } from '../src/telemetry.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'admin-env-'));

describe('admin environment', () => {
  it('loads .env when present (set variables win) and is silent without one', () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { KEEP: 'preset' };
    prepareAdminEnv(join(dir, '.env'), env); // missing: no error
    expect(env).toEqual({ KEEP: 'preset', OTEL_SERVICE_NAME: ADMIN_SERVICE_NAME });
    writeFileSync(join(dir, '.env'), 'KEEP=file\nPROVIDER_URI=docker:///x.sock\n');
    const env2: NodeJS.ProcessEnv = { KEEP: 'preset' };
    prepareAdminEnv(join(dir, '.env'), env2);
    expect(env2).toMatchObject({ KEEP: 'preset', PROVIDER_URI: 'docker:///x.sock' });
  });

  it('names the CLI ozwell-computer-admin unless OTEL_SERVICE_NAME is set (also in .env)', () => {
    const env: NodeJS.ProcessEnv = {};
    prepareAdminEnv(join(tmp(), '.env'), env);
    expect(telemetryConfig(env).serviceName).toBe('ozwell-computer-admin');
    const explicit: NodeJS.ProcessEnv = { OTEL_SERVICE_NAME: 'mine' };
    prepareAdminEnv(join(tmp(), '.env'), explicit);
    expect(explicit.OTEL_SERVICE_NAME).toBe('mine');
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'OTEL_SERVICE_NAME=from-file\n');
    const fromFile: NodeJS.ProcessEnv = {};
    prepareAdminEnv(join(dir, '.env'), fromFile);
    expect(fromFile.OTEL_SERVICE_NAME).toBe('from-file');
  });
});

describe('bin/admin', () => {
  const bin = fileURLToPath(new URL('../bin/admin', import.meta.url));
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(bin, args, { cwd: tmp(), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

  it('runs from any directory without a .env notice', () => {
    const r = run(['list'], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PROVIDER_URI is required/);
    expect(r.stderr).not.toMatch(/\.env/);
  });

  it('writes audit lines', () => {
    // An unreachable docker socket: create fails, which is still audited.
    const r = run(['create', '--user', 'u-1'], { USER: 'alice', PROVIDER_URI: 'docker:///nonexistent.sock' });
    expect(r.status).toBe(1);
    const line = JSON.parse(r.stderr.split('\n').find((l) => l.startsWith('{'))!);
    expect(line).toMatchObject({ name: 'ozwell-computer-admin', component: 'admin', operator: 'alice', action: 'create', outcome: 'failed' });
  });
});
