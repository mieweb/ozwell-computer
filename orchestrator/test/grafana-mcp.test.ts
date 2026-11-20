// grafana-mcp: the token bootstrap (deploy/grafana-mcp/bootstrap-token.ts) against a fake
// Grafana, and the compose, proxy and guide configuration it relies on.
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../deploy/grafana-mcp/bootstrap-token.ts';

interface Sa { id: number; name: string; role: string; isDisabled: boolean; tokens: { id: number; name: string; key: string }[] }

/** A fake Grafana: service accounts and tokens, basic auth for admin, bearer for tokens. */
function fakeGrafana(o: { accounts?: Sa[]; healthFailures?: number; password?: string; badNewTokens?: boolean } = {}) {
  const accounts = o.accounts ?? [];
  const calls: string[] = [];
  let health = o.healthFailures ?? 0;
  let next = 100;
  const admin = 'Basic ' + Buffer.from(`admin:${o.password ?? 'pw'}`).toString('base64');
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (path === '/api/health') return health-- > 0 ? json(503, {}) : json(200, { database: 'ok' });
    if (auth.startsWith('Bearer ')) {
      const key = auth.slice(7);
      const ok = !o.badNewTokens && accounts.some((a) => a.tokens.some((t) => t.key === key));
      return ok ? json(200, []) : json(401, { message: 'invalid API key' });
    }
    if (auth !== admin) return json(401, { message: 'invalid username or password' });
    let m;
    if (method === 'GET' && path === '/api/serviceaccounts/search') {
      const q = url.searchParams.get('query') ?? '';
      return json(200, { serviceAccounts: accounts.filter((a) => a.name.includes(q)) });
    }
    if (method === 'POST' && path === '/api/serviceaccounts') {
      const sa = { id: next++, name: body.name, role: body.role, isDisabled: body.isDisabled, tokens: [] };
      accounts.push(sa);
      return json(201, sa);
    }
    if ((m = path.match(/^\/api\/serviceaccounts\/(\d+)$/)) && method === 'PATCH') {
      Object.assign(accounts.find((a) => a.id === Number(m![1]))!, body);
      return json(200, {});
    }
    if ((m = path.match(/^\/api\/serviceaccounts\/(\d+)\/tokens$/))) {
      const sa = accounts.find((a) => a.id === Number(m![1]))!;
      if (method === 'GET') return json(200, sa.tokens.map(({ id, name }) => ({ id, name })));
      const t = { id: next++, name: body.name, key: `glsa_${next}` };
      sa.tokens.push(t);
      return json(200, { id: t.id, name: t.name, key: t.key });
    }
    if ((m = path.match(/^\/api\/serviceaccounts\/(\d+)\/tokens\/(\d+)$/)) && method === 'DELETE') {
      const sa = accounts.find((a) => a.id === Number(m![1]))!;
      sa.tokens = sa.tokens.filter((t) => t.id !== Number(m![2]));
      return json(200, {});
    }
    return json(404, { message: 'not found' });
  }) as typeof fetch;
  return { fetch: f, accounts, calls };
}

const tokenFile = () => join(mkdtempSync(join(tmpdir(), 'grafana-mcp-')), 'token');
const opts = (g: ReturnType<typeof fakeGrafana>, file: string) => ({
  url: 'http://grafana:3000/', user: 'admin', password: 'pw', tokenFile: file, fetch: g.fetch, sleep: async () => {}, log: () => {},
});

describe('grafana-mcp token bootstrap', () => {
  it('creates the Viewer service account, writes a working token (0600)', async () => {
    const g = fakeGrafana({ healthFailures: 2 });
    const file = tokenFile();
    const r = await bootstrap(opts(g, file));
    expect(r).toMatchObject({ created: true, updated: false, revoked: 0 });
    expect(g.accounts).toHaveLength(1);
    expect(g.accounts[0]).toMatchObject({ name: 'mcp', role: 'Viewer', isDisabled: false });
    expect(readFileSync(file, 'utf8')).toBe(`${g.accounts[0].tokens[0].key}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(g.calls.filter((c) => c === 'GET /api/health')).toHaveLength(3);
  });

  it('resets a drifted account and revokes older tokens only after writing the new one', async () => {
    const old = [{ id: 1, name: 'a', key: 'glsa_old1' }, { id: 2, name: 'b', key: 'glsa_old2' }];
    const g = fakeGrafana({ accounts: [
      { id: 7, name: 'mcp-other', role: 'Admin', isDisabled: false, tokens: [{ id: 3, name: 'c', key: 'glsa_other' }] },
      { id: 8, name: 'mcp', role: 'Editor', isDisabled: true, tokens: [...old] },
    ] });
    const file = tokenFile();
    const r = await bootstrap(opts(g, file));
    expect(r).toMatchObject({ serviceAccountId: 8, created: false, updated: true, revoked: 2 });
    const sa = g.accounts.find((a) => a.id === 8)!;
    expect(sa).toMatchObject({ role: 'Viewer', isDisabled: false });
    expect(sa.tokens).toHaveLength(1);
    expect(readFileSync(file, 'utf8').trim()).toBe(sa.tokens[0].key);
    // An account whose name only contains "mcp" is left alone.
    expect(g.accounts.find((a) => a.id === 7)).toMatchObject({ role: 'Admin', tokens: [{ key: 'glsa_other' }] });
    const verify = g.calls.indexOf('GET /api/search');
    expect(verify).toBeGreaterThan(g.calls.indexOf('POST /api/serviceaccounts/8/tokens'));
    expect(verify).toBeLessThan(g.calls.indexOf('DELETE /api/serviceaccounts/8/tokens/1'));
  });

  it('leaves the account untouched when it is already right', async () => {
    const g = fakeGrafana({ accounts: [{ id: 5, name: 'mcp', role: 'Viewer', isDisabled: false, tokens: [] }] });
    const r = await bootstrap(opts(g, tokenFile()));
    expect(r).toMatchObject({ created: false, updated: false, revoked: 0 });
    expect(g.calls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });

  it('a wrong admin password fails with a hint, and writes nothing', async () => {
    const g = fakeGrafana({ password: 'other' });
    const file = tokenFile();
    await expect(bootstrap(opts(g, file))).rejects.toThrow(/HTTP 401.*reset-admin-password/);
    expect(existsSync(file)).toBe(false);
  });

  it('a new token that does not work is not written, and older ones are kept', async () => {
    const g = fakeGrafana({ badNewTokens: true, accounts: [{ id: 5, name: 'mcp', role: 'Viewer', isDisabled: false, tokens: [{ id: 1, name: 'a', key: 'glsa_old' }] }] });
    const file = tokenFile();
    await expect(bootstrap(opts(g, file))).rejects.toThrow(/GET \/api\/search\?limit=1: HTTP 401/);
    expect(existsSync(file)).toBe(false);
    expect(g.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('gives up when Grafana does not come up', async () => {
    const g = fakeGrafana({ healthFailures: Infinity });
    await expect(bootstrap({ ...opts(g, tokenFile()), waitMs: 0 })).rejects.toThrow(/did not come up/);
  });
});

describe('grafana-mcp configuration', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const compose = read('../compose.yml');
  const caddy = read('../deploy/caddy/Caddyfile');
  const datasources = read('../deploy/grafana/provisioning/datasources/datasources.yml');
  const guide = read('../deploy/grafana-mcp/rca-guide.md');
  const service = compose.slice(compose.indexOf('\n  grafana-mcp:\n'), compose.indexOf('\nvolumes:\n'));

  it('runs read-only, behind a caller token, never at debug level', () => {
    for (const flag of ['--disable-write', '--disable-api', '--transport=streamable-http', '--allowed-hosts=grafana-mcp:8000', '--usage-stats=disabled', '--log-level=info'])
      expect(service).toContain(`- ${flag}\n`);
    expect(service).not.toMatch(/--log-level=debug|- --debug|--enabled-tools=[^\n]*\b(api|admin|rendering|runpanelquery)\b/);
    expect(service).toContain('MCP_GRAFANA_SERVER_TOKEN: ${MCP_GRAFANA_SERVER_TOKEN:?');
    expect(service).toContain('GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE: /run/grafana-mcp/token');
    expect(service).toContain('grafana-mcp-token: { condition: service_completed_successfully }');
    // Published only through the proxy, which sets the Host it accepts and drops callers'
    // Grafana URL, org and credential headers.
    expect(service).not.toMatch(/^\s+ports:/m);
    expect(caddy).toMatch(/:8092 \{\n\treverse_proxy grafana-mcp:8000 \{[^}]*header_up Host grafana-mcp:8000[^}]*header_up -X-Grafana-\*/);
  });

  it('has a Tempo datasource on VictoriaTraces, and the guide names only provisioned uids', () => {
    expect(datasources).toMatch(/uid: victoriatraces-tempo\n\s+type: tempo\n\s+access: proxy\n\s+url: http:\/\/victoriatraces:10428\/select\/tempo\n/);
    const uids = new Set([...datasources.matchAll(/^\s+uid: (\S+)$/gm)].map((m) => m[1]));
    const named = [...guide.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
    expect(named).toEqual(['victoriametrics', 'victorialogs', 'victoriatraces-tempo']);
    for (const uid of named) expect(uids).toContain(uid);
  });
});
