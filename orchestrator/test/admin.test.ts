import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runAdmin, parseDuration, type AdminDeps } from '../src/admin.ts';
import { createId, type Computer, type Provider } from '../src/providers/types.ts';

// ---- fake computers: just the REST routes the CLI uses

type Behaviour = 'succeed' | 'unchanged' | 'fail' | 'restart' | 'hang' | 'instant' | 'drop';
interface FakeOpts {
  version?: string; latest?: string; supported?: boolean; roster?: Array<{ name: string; kind: string }>;
  behaviour?: Behaviour; state?: string; at?: string; noUpdateRoute?: boolean; checkDelayMs?: number; statusDelayMs?: number; cutOffPolls?: number;
}

const running = { now: 0, max: 0 };
const servers: Server[] = [];

async function fakeComputer(o: FakeOpts = {}) {
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  const s = {
    version: o.version ?? '1.0.0', latest: o.latest ?? o.version ?? '1.0.0',
    upgrade: { state: o.state ?? 'idle', at: (o.at ?? null) as string | null, log: '' },
    roster: (o.roster ?? []).map((p, i) => ({ participant_id: `p${i}`, color: '#000000', cursor: null, joined_at: 0, last_seen: 0, ...p })),
    applied: 0, down: false,
  };
  const status = () => ({
    supported: o.supported ?? true, ...(o.supported === false ? { limitation: 'update checks are off' } : {}),
    url: 'https://example/releases', current: s.version, latest: s.latest, available: s.latest !== s.version,
    checked_at: null, error: null, upgrade: s.upgrade,
  });
  const finish = (state: string) => {
    if (state === 'succeeded') s.version = s.latest;
    if (state === 'failed') s.upgrade.log = 'step 1\nstep 2\nE: dpkg was interrupted';
    s.upgrade = { ...s.upgrade, state, at: new Date().toISOString() };
    running.now--;
  };
  let cutOff = o.cutOffPolls ?? 0;
  const server = createServer((req, res) => {
    const send = (code: number, body?: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (s.down) return send(503, { error: { reason: 'target_unavailable', message: 'restarting' } });
    const route = `${req.method} ${req.url}`;
    if (route === 'GET /health') return send(204); // unauthenticated, like the real one
    if (req.headers.authorization !== `Bearer ${token}`) return send(401);
    if (route === 'GET /api/v1/capabilities') return send(200, { version: s.version });
    if (route === 'GET /api/v1/presence') return send(200, { roster: s.roster });
    if (o.noUpdateRoute && req.url!.startsWith('/api/v1/update')) return send(501, { error: { reason: 'feature_unsupported', message: 'update checks are not running' } });
    if (route === 'POST /api/v1/update/check' && o.checkDelayMs) { setTimeout(() => send(200, status()), o.checkDelayMs); return; }
    if (route === 'GET /api/v1/update' && s.applied && cutOff > 0) {
      // Headers and part of the body, then the connection drops (the server restarting).
      cutOff--;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"supported":tr');
      setTimeout(() => res.socket?.destroy(), 5);
      return;
    }
    if (route === 'GET /api/v1/update' && o.statusDelayMs && s.applied) { setTimeout(() => send(200, status()), o.statusDelayMs); return; }
    if (route === 'GET /api/v1/update' || route === 'POST /api/v1/update/check') return send(200, status());
    if (route === 'POST /api/v1/update/apply') {
      s.applied++;
      s.upgrade = { state: 'requested', at: new Date().toISOString(), log: '' };
      running.now++; running.max = Math.max(running.max, running.now);
      const b = o.behaviour ?? 'succeed';
      if (b === 'drop') { setTimeout(() => finish('succeeded'), 60); req.socket.destroy(); return; } // accepted, no answer
      if (b === 'instant') { finish('succeeded'); return send(202, status()); } // done before apply answers
      setTimeout(() => { s.upgrade = { ...s.upgrade, state: 'running' }; }, 20);
      if (b === 'restart') {
        // The server goes away mid-upgrade (connection refused), then comes back upgraded.
        setTimeout(() => {
          const port = (server.address() as any).port;
          server.closeAllConnections();
          server.close(() => setTimeout(() => { finish('succeeded'); server.listen(port, '127.0.0.1'); }, 150));
        }, 40);
      } else if (b !== 'hang') {
        setTimeout(() => finish(b === 'succeed' ? 'succeeded' : b === 'unchanged' ? 'unchanged' : 'failed'), 120);
      }
      return send(202, status());
    }
    return send(404, { error: { reason: 'not_found', message: route } });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { s, token, url: `http://127.0.0.1:${(server.address() as any).port}` };
}

afterAll(async () => { for (const sv of servers) { sv.closeAllConnections(); sv.close(); } });
afterEach(() => { running.now = 0; running.max = 0; });

// ---- fake provider

function memoryProvider(seed: Computer[] = [], opts: { offlineGets?: number; url?: string; token?: string } = {}) {
  const all = new Map(seed.map((c) => [c.id, c]));
  const destroyed: string[] = [];
  let offline = opts.offlineGets ?? 0;
  const p: Provider = {
    scheme: 'memory',
    async list(owner) { return [...all.values()].filter((c) => c.owner === owner); },
    async listAll() { return [...all.values()]; },
    async get(id) {
      const c = all.get(id);
      if (!c) return null;
      // A new opensource-server computer reports offline (stopped) for a while.
      if (offline > 0) { offline--; return { ...c, status: 'offline', stopped: true }; }
      return c;
    },
    async create({ owner, displayName, id }) {
      const cid = createId({ owner, id });
      if (all.has(cid)) throw new Error(`a container named ${cid} already exists`);
      const c: Computer = {
        id: cid, owner: owner.id, ownerEmail: owner.email, displayName, status: opts.offlineGets ? 'offline' : 'running',
        stopped: !!opts.offlineGets, createdAt: new Date().toISOString(), internalUrl: opts.url, token: opts.token,
      };
      all.set(cid, c);
      return c;
    },
    async start(id) { return all.get(id)!; },
    async destroy(id) { if (id === 'explodes') throw new Error('boom'); all.delete(id); destroyed.push(id); },
  };
  return { p, all, destroyed };
}

const comp = (id: string, extra: Partial<Computer> = {}): Computer =>
  ({ id, owner: 'u-alice', ownerEmail: 'Alice@Example.com', status: 'running', stopped: false, createdAt: '2026-11-01T00:00:00.000Z', ...extra });

const onFake = async (id: string, o: FakeOpts = {}, extra: Partial<Computer> = {}) => {
  const f = await fakeComputer(o);
  return { f, c: comp(id, { internalUrl: f.url, token: f.token, ...extra }) };
};

function harness(provider: Provider, over: Partial<AdminDeps> = {}) {
  const out: string[] = [], err: string[] = [], audit: Array<Record<string, unknown>> = [];
  const deps: AdminDeps = {
    provider, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), audit: (r) => audit.push(r),
    pollMs: 20, readyIntervalMs: 20, probeTimeoutMs: 1000, ...over,
  };
  return { deps, out, err, audit, run: (...argv: string[]) => runAdmin(argv, deps) };
}

// ---- tests

describe('admin CLI: arguments and exit codes', () => {
  it('usage errors exit 2', async () => {
    const h = harness(memoryProvider().p);
    expect(await h.run()).toBe(2);
    expect(await h.run('nope')).toBe(2);
    expect(await h.run('list', '--bogus')).toBe(2);
    expect(await h.run('create')).toBe(2); // --user required
    expect(await h.run('create', '--user', 'u', '--id', 'Bad_Id')).toBe(2);
    expect(await h.run('delete')).toBe(2); // no selection
    expect(await h.run('delete', '--all', '--user', 'x')).toBe(2); // two selections
    expect(await h.run('update', '--all', '--parallel', '0')).toBe(2);
    expect(await h.run('update', '--all', '--timeout', 'soon')).toBe(2);
    expect(h.err.join('\n')).toMatch(/usage:/);
  });

  it('parses durations', () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(() => parseDuration('0s')).toThrow();
  });
});

describe('admin list', () => {
  it('selects by owner id, owner email (any case), or everything; probes running computers', async () => {
    const a = await onFake('a-1', { version: '2.1.0', roster: [{ name: 'Alice', kind: 'human' }, { name: 'claude', kind: 'agent' }] });
    const { p } = memoryProvider([
      a.c,
      comp('a-2', { stopped: true, status: 'exited' }),
      comp('b-1', { owner: 'u-bob', ownerEmail: undefined, displayName: 'Bob box' }),
    ]);
    const h = harness(p);
    expect(await h.run('list', '--user', 'u-alice', '--json')).toBe(0);
    const rows = h.out.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.id)).toEqual(['a-1', 'a-2']);
    expect(rows[0]).toMatchObject({ version: '2.1.0', connected: [{ name: 'Alice', kind: 'human' }, { name: 'claude', kind: 'agent' }] });
    expect(rows[1]).toMatchObject({ stopped: true, version: null, connected: null });
    expect(JSON.stringify(rows)).not.toContain(a.f.token); // tokens never printed

    h.out.length = 0;
    expect(await h.run('list', '--user', 'alice@example.COM', '--json')).toBe(0);
    expect(h.out).toHaveLength(2);

    h.out.length = 0;
    expect(await h.run('list')).toBe(0);
    expect(h.out[0]).toMatch(/^ID\s+OWNER\s+NAME\s+STATUS/);
    expect(h.out.join('\n')).toMatch(/a-1\s+Alice@Example.com.*2\.1\.0\s+Alice, claude \(agent\)/);
    expect(h.out.join('\n')).toMatch(/b-1\s+u-bob\s+Bob box/);
  });

  it('leaves version blank for unreachable computers', async () => {
    const h = harness(memoryProvider([comp('gone', { internalUrl: 'http://127.0.0.1:1', token: 't' })]).p);
    expect(await h.run('list', '--json')).toBe(0);
    expect(JSON.parse(h.out[0])).toMatchObject({ id: 'gone', version: null, connected: null });
  });
});

describe('admin create', () => {
  it('creates with a generated id, and with a requested one', async () => {
    const { p, all } = memoryProvider();
    const h = harness(p);
    expect(await h.run('create', '--user', 'u-1', '--email', 'one@example.com', '--name', 'Box', '--json')).toBe(0);
    const made = JSON.parse(h.out[0]);
    expect(made.id).toMatch(/^ozc-/);
    expect(all.get(made.id)).toMatchObject({ owner: 'u-1', ownerEmail: 'one@example.com', displayName: 'Box' });
    expect(await h.run('create', '--user', 'u-1', '--id', 'chosen-1', '--json')).toBe(0);
    expect(all.has('chosen-1')).toBe(true);
    expect(h.audit).toEqual([
      expect.objectContaining({ action: 'create', instance: made.id, outcome: 'created' }),
      expect.objectContaining({ action: 'create', instance: 'chosen-1', requested_id: 'chosen-1', outcome: 'created' }),
    ]);
  });

  it('refuses an existing id', async () => {
    const { p } = memoryProvider([comp('taken')]);
    const h = harness(p);
    expect(await h.run('create', '--user', 'u-1', '--id', 'taken')).toBe(1);
    expect(h.err.join()).toMatch(/already exists/);
    expect(h.audit).toEqual([]);
  });

  it('warns over the quota but creates anyway', async () => {
    const { p, all } = memoryProvider([comp('a-1'), comp('a-2')]);
    const h = harness(p, { env: { ORCHESTRATOR_MAX_INSTANCES: '2' } });
    expect(await h.run('create', '--user', 'u-alice')).toBe(0);
    expect(h.err.join()).toMatch(/already has 2 computer\(s\); ORCHESTRATOR_MAX_INSTANCES is 2/);
    expect(all.size).toBe(3);
  });

  it('needs --email for opensource-server with owner=email', async () => {
    const h = harness(memoryProvider().p, { env: { PROVIDER_URI: 'opensource-server://h?site=1&domain=1&owner=email' } });
    expect(await h.run('create', '--user', 'u-1')).toBe(2);
    expect(h.err.join()).toMatch(/--email/);
  });

  it('--wait waits through the offline phase of a new computer', async () => {
    const f = await fakeComputer();
    const mem = memoryProvider([], { offlineGets: 3, url: f.url, token: f.token });
    // Comes up after the offline gets: the stored computer becomes running.
    const get = mem.p.get.bind(mem.p);
    mem.p.get = async (id) => { const c = await get(id); const stored = mem.all.get(id); if (stored) mem.all.set(id, { ...stored, status: 'running', stopped: false }); return c; };
    const h = harness(mem.p);
    expect(await h.run('create', '--user', 'u-1', '--wait', '--json')).toBe(0);
    expect(JSON.parse(h.out[0])).toMatchObject({ status: 'running', ready: true });
  });
});

describe('admin delete', () => {
  it('refuses --all and --user without --yes (no terminal)', async () => {
    const { p, destroyed } = memoryProvider([comp('a-1'), comp('b-1', { owner: 'u-bob' })]);
    const h = harness(p);
    expect(await h.run('delete', '--all')).toBe(2);
    expect(await h.run('delete', '--user', 'u-alice')).toBe(2);
    expect(destroyed).toEqual([]);
  });

  it('asks on a terminal, and only a matching answer deletes', async () => {
    const { p, destroyed } = memoryProvider([comp('a-1'), comp('a-2')]);
    let answer = 'yes';
    const h = harness(p, { prompt: async () => answer });
    expect(await h.run('delete', '--user', 'u-alice')).toBe(1);
    expect(destroyed).toEqual([]);
    answer = 'delete 2';
    expect(await h.run('delete', '--user', 'u-alice')).toBe(0);
    expect(destroyed.sort()).toEqual(['a-1', 'a-2']);
  });

  it('deletes by --id without asking, continues after failures, and reports missing ids', async () => {
    const { p, destroyed } = memoryProvider([comp('a-1'), comp('explodes'), comp('b-1', { owner: 'u-bob' })]);
    const h = harness(p);
    expect(await h.run('delete', '--id', 'a-1', '--id', 'explodes', '--id', 'nope', '--json')).toBe(1);
    expect(destroyed).toEqual(['a-1']);
    expect(h.out.map((l) => JSON.parse(l))).toEqual([
      { id: 'a-1', outcome: 'deleted' }, { id: 'explodes', outcome: 'failed', error: 'boom' }, { id: 'nope', outcome: 'not found' },
    ]);
    expect(h.audit.map((a) => [a.action, a.instance, a.outcome])).toEqual([['delete', 'a-1', 'deleted'], ['delete', 'explodes', 'failed']]);
  });

  it('reports ids that are all missing, also with --json', async () => {
    const h = harness(memoryProvider([comp('a-1')]).p);
    expect(await h.run('delete', '--id', 'gone', '--json')).toBe(1);
    expect(h.out.map((l) => JSON.parse(l))).toEqual([{ id: 'gone', outcome: 'not found' }]);
  });

  it('shows the targets on stderr in --json mode before confirming', async () => {
    const busy = await onFake('a-1', { roster: [{ name: 'Alice', kind: 'human' }] });
    let shownBeforePrompt = '';
    const h = harness(memoryProvider([busy.c]).p, { prompt: async () => { shownBeforePrompt = h.err.join('\n'); return 'delete 1'; } });
    expect(await h.run('delete', '--user', 'u-alice', '--json')).toBe(0);
    expect(shownBeforePrompt).toMatch(/a-1.*Alice/);
    expect(h.out.map((l) => JSON.parse(l))).toEqual([{ id: 'a-1', outcome: 'deleted' }]);
  });

  it('--all --yes deletes everything', async () => {
    const { p, all } = memoryProvider([comp('a-1'), comp('b-1', { owner: 'u-bob' })]);
    expect(await harness(p).run('delete', '--all', '--yes')).toBe(0);
    expect(all.size).toBe(0);
  });
});

describe('admin update', () => {
  const results = (h: ReturnType<typeof harness>) => h.out.map((l) => JSON.parse(l));

  it('skips stopped and unsupported computers, reports current ones', async () => {
    const unsupported = await onFake('unsup', { supported: false });
    const noRoute = await onFake('noroute', { noUpdateRoute: true });
    const current = await onFake('cur', { version: '3.0.0' });
    const { p } = memoryProvider([comp('stopped', { stopped: true, status: 'exited' }), unsupported.c, noRoute.c, current.c]);
    const h = harness(p);
    expect(await h.run('update', '--all', '--json')).toBe(1);
    const r = Object.fromEntries(results(h).map((x) => [x.id, x]));
    expect(r.stopped.outcome).toBe('stopped');
    expect(r.unsup).toMatchObject({ outcome: 'unsupported', detail: 'update checks are off' });
    expect(r.noroute).toMatchObject({ outcome: 'unsupported', detail: 'update checks are not running' });
    expect(r.cur).toMatchObject({ outcome: 'current', before: '3.0.0' });
    expect(current.f.s.applied).toBe(0);
    expect(h.audit).toEqual([]);
  });

  it('exits 0 when every computer is current', async () => {
    const current = await onFake('cur', { version: '3.0.0' });
    expect(await harness(memoryProvider([current.c]).p).run('update', '--all')).toBe(0);
  });

  it('skips a computer in use unless --force', async () => {
    const busy = await onFake('busy', { latest: '1.1.0', roster: [{ name: 'Alice', kind: 'human' }] });
    const { p } = memoryProvider([busy.c]);
    let h = harness(p);
    expect(await h.run('update', '--id', 'busy', '--json')).toBe(1);
    expect(results(h)[0]).toMatchObject({ outcome: 'in use', detail: expect.stringMatching(/Alice/) });
    expect(busy.f.s.applied).toBe(0);
    h = harness(p);
    expect(await h.run('update', '--id', 'busy', '--force', '--json')).toBe(0);
    expect(results(h)[0]).toMatchObject({ outcome: 'updated', before: '1.0.0', after: '1.1.0' });
    expect(h.audit[0]).toMatchObject({ action: 'update', instance: 'busy', forced: true, outcome: 'requested' });
  });

  it('reports success, unchanged, and failure with the upgrade log', async () => {
    const ok = await onFake('ok', { latest: '1.1.0' });
    const same = await onFake('same', { latest: '1.1.0', behaviour: 'unchanged' });
    const bad = await onFake('bad', { latest: '1.1.0', behaviour: 'fail' });
    const h = harness(memoryProvider([ok.c, same.c, bad.c]).p);
    expect(await h.run('update', '--user', 'alice@example.com')).toBe(1);
    const text = h.out.join('\n');
    expect(text).toMatch(/ok: updated \(1\.0\.0 -> 1\.1\.0\)/);
    expect(text).toMatch(/same: unchanged/);
    expect(text).toMatch(/bad: failed: upgrade failed\n {4}step 1\n {4}step 2\n {4}E: dpkg was interrupted/);
    expect(h.err.join()).toMatch(/summary: .*1 updated.*/);
    expect(h.audit.filter((a) => a.outcome !== 'requested').map((a) => [a.instance, a.outcome]).sort())
      .toEqual([['bad', 'failed'], ['ok', 'updated'], ['same', 'unchanged']]);
  });

  it('keeps polling through a server restart', async () => {
    const r = await onFake('restarts', { latest: '1.2.0', behaviour: 'restart' });
    const h = harness(memoryProvider([r.c]).p);
    expect(await h.run('update', '--id', 'restarts', '--json')).toBe(0);
    expect(results(h)[0]).toMatchObject({ outcome: 'updated', after: '1.2.0' });
  });

  it('waits on an upgrade already in progress instead of starting another', async () => {
    const r = await onFake('busyup', { latest: '1.1.0', behaviour: 'hang', state: 'running' });
    const h = harness(memoryProvider([r.c]).p);
    setTimeout(() => { r.f.s.version = '1.1.0'; r.f.s.upgrade = { state: 'succeeded', at: new Date().toISOString(), log: '' }; }, 100);
    expect(await h.run('update', '--id', 'busyup', '--json')).toBe(0);
    expect(r.f.s.applied).toBe(0);
    expect(results(h)[0]).toMatchObject({ outcome: 'updated', after: '1.1.0' });
  });

  it('takes a result already in the apply response, but not one left from an earlier upgrade', async () => {
    const fast = await onFake('fast', { latest: '1.1.0', behaviour: 'instant', state: 'succeeded', at: '2026-01-01T00:00:00.000Z' });
    let h = harness(memoryProvider([fast.c]).p);
    expect(await h.run('update', '--id', 'fast', '--timeout', '2s', '--json')).toBe(0);
    expect(results(h)[0]).toMatchObject({ outcome: 'updated', after: '1.1.0' });
    const old = await onFake('old', { latest: '1.1.0', behaviour: 'hang', state: 'succeeded', at: '2026-01-01T00:00:00.000Z' });
    h = harness(memoryProvider([old.c]).p);
    expect(await h.run('update', '--id', 'old', '--timeout', '300ms', '--json')).toBe(1);
    expect(results(h)[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('gives an update check longer than the probe budget', async () => {
    const slow = await onFake('slowcheck', { checkDelayMs: 300 });
    const { ComputerApi } = await import('../src/computer-api.ts');
    const api = new ComputerApi(slow.c, 100);
    await expect(api.presence()).resolves.toEqual([]);
    await expect(api.checkUpdate()).resolves.toMatchObject({ available: false });
  });

  it('does not apply once --timeout has run out during the checks', async () => {
    const late = await onFake('late', { latest: '1.1.0', checkDelayMs: 300 });
    const h = harness(memoryProvider([late.c]).p);
    expect(await h.run('update', '--id', 'late', '--timeout', '100ms', '--json')).toBe(1);
    expect(results(h)[0]).toMatchObject({ outcome: 'timeout', detail: expect.stringMatching(/before applying/) });
    expect(late.f.s.applied).toBe(0);
    expect(h.audit).toEqual([]);
  });

  it('watches an upgrade whose apply response was lost instead of failing it', async () => {
    const d = await onFake('dropped', { latest: '1.1.0', behaviour: 'drop' });
    const h = harness(memoryProvider([d.c]).p);
    expect(await h.run('update', '--id', 'dropped', '--json')).toBe(0);
    expect(results(h)[0]).toMatchObject({ outcome: 'updated', after: '1.1.0' });
    expect(d.f.s.applied).toBe(1);
  });

  it('fails when apply is refused outright', async () => {
    const d = await onFake('noapply', { latest: '1.1.0', noUpdateRoute: false });
    d.c.token = 'wrong'; // 401 on every call: never reaches apply
    const h = harness(memoryProvider([d.c]).p);
    expect(await h.run('update', '--id', 'noapply', '--json')).toBe(1);
    expect(results(h)[0]).toMatchObject({ outcome: 'failed' });
  });

  it('does not count a result that arrives after --timeout', async () => {
    // Finishes at ~120 ms, but each status answer takes 150 ms: the first poll that could
    // see it starts before the deadline and would answer after it.
    const late = await onFake('lateok', { latest: '1.1.0', statusDelayMs: 150 });
    const h = harness(memoryProvider([late.c]).p, { pollMs: 50 });
    expect(await h.run('update', '--id', 'lateok', '--timeout', '200ms', '--json')).toBe(1);
    expect(results(h)[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('retries a status response cut off mid-body, without failing the batch', async () => {
    const cut = await onFake('cut', { latest: '1.1.0', cutOffPolls: 2 });
    const other = await onFake('other', { latest: '1.1.0' });
    const h = harness(memoryProvider([cut.c, other.c]).p);
    expect(await h.run('update', '--all', '--json')).toBe(0);
    expect(results(h).map((r) => [r.id, r.outcome]).sort()).toEqual([['cut', 'updated'], ['other', 'updated']]);
  });

  it('gives up at --timeout', async () => {
    const r = await onFake('slow', { latest: '1.1.0', behaviour: 'hang' });
    const h = harness(memoryProvider([r.c]).p);
    expect(await h.run('update', '--id', 'slow', '--timeout', '300ms', '--json')).toBe(1);
    expect(results(h)[0]).toMatchObject({ outcome: 'timeout', detail: expect.stringMatching(/last state: running/) });
  });

  it('runs at most --parallel upgrades at once', async () => {
    const fakes = await Promise.all(Array.from({ length: 5 }, (_, i) => onFake(`par-${i}`, { latest: '1.1.0' })));
    const h = harness(memoryProvider(fakes.map((f) => f.c)).p);
    expect(await h.run('update', '--all', '--parallel', '2', '--json')).toBe(0);
    expect(results(h).every((r) => r.outcome === 'updated')).toBe(true);
    expect(running.max).toBe(2);
  });
});
