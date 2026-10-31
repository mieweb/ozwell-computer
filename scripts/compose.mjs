// Helpers for the compose-based dev container (shared by `npm test` and `npm run watch`).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE = 'ozwell-computer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function compose(args, { inherit = false, check = true } = {}) {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  if (r.error) throw new Error(`docker compose is required (${r.error.message})`);
  if (check && r.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${r.stderr ?? ''}`);
  return { status: r.status, out: (r.stdout ?? '').trim() };
}

export function isRunning() {
  return compose(['ps', '--status', 'running', '-q', SERVICE], { check: false }).out !== '';
}

/** Start the service if needed (building the image only if it doesn't exist yet). */
export function up() {
  compose(['up', '-d', SERVICE], { inherit: true });
}

/** Restart only the Node server inside the container (picks up a new ./dist). */
export function restartServer() {
  // A user unit of the desktop user (started by its desktop session).
  compose(['exec', '-T', SERVICE, 'systemctl', '--user', '-M', 'desktop@', 'restart', 'ozwell-computer.service']);
}

export function url() {
  const hostPort = compose(['port', SERVICE, '8080']).out.split('\n')[0]; // e.g. 0.0.0.0:8080 or [::]:8080
  const port = hostPort.slice(hostPort.lastIndexOf(':') + 1);
  return `http://127.0.0.1:${port}`;
}

export function token() {
  for (const cmd of [['printenv', 'OZWELL_COMPUTER_TOKEN'], ['cat', '/var/lib/ozwell-computer/token']]) {
    const r = compose(['exec', '-T', SERVICE, ...cmd], { check: false });
    if (r.status === 0 && r.out) return r.out;
  }
  return null;
}

/** The token the service generated (not one configured via its environment), or null. */
export function generatedToken() {
  // A configured token wins over the file, and must never be copied or printed.
  const env = compose(['exec', '-T', SERVICE, 'printenv', 'OZWELL_COMPUTER_TOKEN'], { check: false });
  if (env.status === 0 && env.out) return null;
  const r = compose(['exec', '-T', SERVICE, 'cat', '/var/lib/ozwell-computer/token'], { check: false });
  return r.status === 0 && r.out ? r.out : null;
}

/** Wait until /health is 204 and the desktop session has at least one window. */
export async function waitReady({ timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  for (;;) {
    try {
      const base = url();
      const tok = token();
      if (tok && (await fetch(`${base}/health`)).status === 204) {
        const w = await (await fetch(`${base}/api/v1/windows`, { headers: { authorization: `Bearer ${tok}` } })).json();
        if (w.windows?.length) return { url: base, token: tok };
      }
    } catch (e) { lastErr = e.message; }
    if (Date.now() > deadline) {
      const logs = compose(['exec', '-T', SERVICE, 'journalctl', '_SYSTEMD_USER_UNIT=ozwell-computer.service', '--no-pager', '-n', '40'], { check: false }).out;
      throw new Error(`ozwell-computer did not become ready within ${timeoutMs / 1000}s (${lastErr})\n${logs}`);
    }
    await sleep(500);
  }
}
