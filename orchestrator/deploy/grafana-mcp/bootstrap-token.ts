// One-shot (compose service grafana-mcp-token, on every `docker compose up`): ensures the
// Grafana service account `mcp` exists with role Viewer, mints a new token for it, writes
// it atomically to TOKEN_FILE for grafana-mcp, then revokes the account's older tokens.
// Grafana's file provisioning can't create service accounts or tokens, hence this script.
// mcp-grafana reads GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE on every request, so it picks up
// the new token without a restart. Only node built-ins: it runs in a plain node image.
import { chownSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface BootstrapOptions {
  url: string;
  user: string;
  password: string;
  tokenFile: string;
  /** "uid:gid" the token file is given: mcp-grafana's image user must read it. */
  owner?: string;
  name?: string;
  role?: string;
  /** How long to wait for Grafana to answer /api/health. */
  waitMs?: number;
  /** Time limit for each Grafana API request (and each health check). */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface BootstrapResult {
  serviceAccountId: number;
  created: boolean;
  updated: boolean;
  revoked: number;
}

interface ServiceAccount { id: number; name: string; role: string; isDisabled: boolean }
interface Token { id: number; name: string }

export async function bootstrap(o: BootstrapOptions): Promise<BootstrapResult> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? ((m: string) => console.log(m));
  const name = o.name ?? 'mcp';
  const role = o.role ?? 'Viewer';
  const base = o.url.replace(/\/+$/, '');
  const basic = 'Basic ' + Buffer.from(`${o.user}:${o.password}`).toString('base64');
  // Every request has a time limit: Grafana accepting a connection and never answering
  // must fail the one-shot, not hang it (and grafana-mcp, which waits for it).
  const requestTimeout = o.requestTimeoutMs ?? 30_000;

  async function api<T>(method: string, path: string, body?: unknown, auth = basic): Promise<T> {
    const res = await f(base + path, {
      method,
      headers: { authorization: auth, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeout),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 && auth === basic
        ? ' (check GF_SECURITY_ADMIN_USER/_PASSWORD; Grafana only applies the password on its first start: ' +
          'after changing it in .env, run `docker compose exec grafana grafana cli admin reset-admin-password <new>`)'
        : '';
      throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}${hint}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  const deadline = Date.now() + (o.waitMs ?? 120_000);
  for (;;) {
    try {
      // Never past the deadline, so a stalled health check still ends in the error below.
      const left = Math.max(1, Math.min(requestTimeout, deadline - Date.now()));
      const res = await f(`${base}/api/health`, { signal: AbortSignal.timeout(left) });
      await res.body?.cancel();
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`Grafana at ${base} did not come up`);
    await sleep(2000);
  }

  const found = await api<{ serviceAccounts: ServiceAccount[] }>('GET', `/api/serviceaccounts/search?query=${encodeURIComponent(name)}&perpage=1000`);
  let sa = found.serviceAccounts.find((a) => a.name === name);
  let created = false;
  let updated = false;
  if (!sa) {
    sa = await api<ServiceAccount>('POST', '/api/serviceaccounts', { name, role, isDisabled: false });
    created = true;
    log(`created service account ${name} (id ${sa.id}, role ${role})`);
  } else if (sa.role !== role || sa.isDisabled) {
    await api('PATCH', `/api/serviceaccounts/${sa.id}`, { role, isDisabled: false });
    updated = true;
    log(`reset service account ${name} (id ${sa.id}) to role ${role}, enabled (was ${sa.role}${sa.isDisabled ? ', disabled' : ''})`);
  }

  const old = await api<Token[]>('GET', `/api/serviceaccounts/${sa.id}/tokens`);
  const tokenName = `${name}-${new Date().toISOString()}-${randomBytes(3).toString('hex')}`;
  const token = await api<{ key: string }>('POST', `/api/serviceaccounts/${sa.id}/tokens`, { name: tokenName, secondsToLive: 0 });

  // Check it works before anyone relies on it, then swap the file in one rename.
  await api('GET', '/api/search?limit=1', undefined, `Bearer ${token.key}`);
  const tmp = `${o.tokenFile}.tmp`;
  writeFileSync(tmp, token.key + '\n', { mode: 0o600 });
  if (o.owner) {
    const [uid, gid] = o.owner.split(':').map(Number);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`TOKEN_OWNER must be uid:gid, got ${o.owner}`);
    chownSync(tmp, uid, gid);
  }
  renameSync(tmp, o.tokenFile);
  log(`wrote token ${tokenName} to ${o.tokenFile}`);

  // mcp-grafana re-reads the file per request: requests from now on use the new token.
  for (const t of old) await api('DELETE', `/api/serviceaccounts/${sa.id}/tokens/${t.id}`);
  if (old.length) log(`revoked ${old.length} older token(s)`);
  return { serviceAccountId: sa.id, created, updated, revoked: old.length };
}

if (import.meta.main) {
  const env = process.env;
  if (!env.GF_SECURITY_ADMIN_PASSWORD) {
    console.error('GF_SECURITY_ADMIN_PASSWORD is not set');
    process.exit(2);
  }
  try {
    await bootstrap({
      url: env.GRAFANA_URL ?? 'http://grafana:3000',
      user: env.GF_SECURITY_ADMIN_USER || 'admin',
      password: env.GF_SECURITY_ADMIN_PASSWORD,
      tokenFile: env.TOKEN_FILE ?? '/run/grafana-mcp/token',
      owner: env.TOKEN_OWNER || undefined,
    });
  } catch (err) {
    console.error(`grafana-mcp-token: ${(err as Error).message}`);
    process.exit(1);
  }
}
