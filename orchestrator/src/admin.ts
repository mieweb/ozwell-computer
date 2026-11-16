#!/usr/bin/env node
// Admin CLI: list, create, delete and update computers with the orchestrator's own
// configuration (PROVIDER_URI and provider secrets). It talks to the provider and to the
// computers directly, not to a running orchestrator. Being able to run it (host or
// container access) is the admin check.
//
//   npm run -s admin -- list   [--user <id|email>] [--json]
//   npm run -s admin -- create --user <id> [--email <email>] [--name <name>] [--id <id>] [--wait] [--timeout <d>] [--json]
//   npm run -s admin -- delete (--id <id>… | --user <id|email> | --all) [--yes] [--json]
//   npm run -s admin -- update (--id <id>… | --user <id|email> | --all) [--parallel <n>] [--timeout <d>] [--force] [--json]
//
// Exit codes: 0 all succeeded, 1 some failed or were skipped, 2 usage or configuration error.
// Every change is written to stderr as a structured audit line (and over OTLP when the
// telemetry endpoints are set, since telemetry.ts is preloaded).
import { parseArgs } from 'node:util';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { observedOwner, validId, ID_PATTERN, type Computer, type Provider } from './providers/types.ts';
import { waitReady, settling } from './mcp.ts';
import { ComputerApi, type Participant, type UpdateStatus } from './computer-api.ts';
import { InstanceError } from './instance-client.ts';

const tracer = trace.getTracer('ozwell-computer-orchestrator');

export interface AdminDeps {
  provider: Provider;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Structured audit record of a change. */
  audit: (record: Record<string, unknown>, msg: string) => void;
  /** Ask on a terminal; undefined when there is none (batches then need --yes). */
  prompt?: (question: string) => Promise<string>;
  /** Update progress poll interval (default 3 s). */
  pollMs?: number;
  /** create --wait poll interval (default 1.5 s). */
  readyIntervalMs?: number;
  /** Version/presence lookups for list and delete (default 5 s). */
  probeTimeoutMs?: number;
}

export class UsageError extends Error {}

const USAGE = `usage:
  admin list   [--user <id|email>] [--json]
  admin create --user <id> [--email <email>] [--name <display name>] [--id <id>] [--wait] [--timeout <duration>] [--json]
  admin delete (--id <id>... | --user <id|email> | --all) [--yes] [--json]
  admin update (--id <id>... | --user <id|email> | --all) [--parallel <n>] [--timeout <duration>] [--force] [--json]
durations: 90s, 15m, 1h, 500ms (a bare number is seconds)`;

/** "15m", "90s", "500ms", "1h", or bare seconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new UsageError(`invalid duration ${JSON.stringify(s)} (e.g. 90s, 15m, 1h)`);
  const n = Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  if (!(n > 0)) throw new UsageError(`duration must be positive: ${s}`);
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items`, at most `limit` at a time, in input order of results. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Does `c` belong to `user` (owner id, or owner email case-insensitively)? */
export const ownedBy = (c: Computer, user: string) =>
  c.owner === user || (!!c.ownerEmail && c.ownerEmail.toLowerCase() === user.toLowerCase());

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd());
}

const describePerson = (p: Participant) => (p.kind === 'agent' ? `${p.name} (agent)` : p.name);

interface Probed { c: Computer; version?: string; connected?: Participant[] }

/** Version and who's connected, for running computers; blank when unreachable. */
async function probe(computers: Computer[], timeoutMs: number): Promise<Probed[]> {
  return Promise.all(computers.map(async (c) => {
    if (c.stopped || !c.internalUrl || !c.token) return { c };
    const api = new ComputerApi(c, timeoutMs);
    const [version, connected] = await Promise.all([api.version().catch(() => undefined), api.presence().catch(() => undefined)]);
    return { c, version, connected };
  }));
}

const asJson = (p: Probed) => ({
  id: p.c.id, owner: p.c.owner, owner_email: p.c.ownerEmail ?? null, display_name: p.c.displayName ?? null,
  status: p.c.status, stopped: p.c.stopped, created_at: p.c.createdAt ?? null,
  version: p.version ?? null, connected: p.connected?.map((x) => ({ name: x.name, kind: x.kind })) ?? null,
});

function printComputers(deps: AdminDeps, rows: Probed[], json: boolean) {
  if (json) { for (const r of rows) deps.out(JSON.stringify(asJson(r))); return; }
  if (!rows.length) { deps.out('no computers'); return; }
  const lines = table([
    ['ID', 'OWNER', 'NAME', 'STATUS', 'STOPPED', 'CREATED', 'VERSION', 'CONNECTED'],
    ...rows.map(({ c, version, connected }) => [
      c.id, observedOwner(c), c.displayName ?? '', settling(c) ? 'starting' : c.status, c.stopped && !settling(c) ? 'yes' : 'no',
      c.createdAt ?? '', version ?? '', connected?.map(describePerson).join(', ') ?? '',
    ]),
  ]);
  for (const l of lines) deps.out(l);
}

type Selection = { ids: string[] } | { user: string } | { all: true };

function selection(values: { id?: string[]; user?: string; all?: boolean }): Selection {
  const modes = [values.id?.length ? 1 : 0, values.user ? 1 : 0, values.all ? 1 : 0].reduce((a, b) => a + b, 0);
  if (modes !== 1) throw new UsageError('choose exactly one of --id <id>..., --user <id|email> or --all');
  if (values.id?.length) return { ids: values.id };
  if (values.user) return { user: values.user };
  return { all: true };
}

/** The targeted computers, plus ids given with --id that don't exist. */
async function select(provider: Provider, sel: Selection): Promise<{ targets: Computer[]; missing: string[] }> {
  if ('ids' in sel) {
    const ids = [...new Set(sel.ids)];
    const found = await Promise.all(ids.map((id) => provider.get(id)));
    return { targets: found.filter((c): c is Computer => !!c), missing: ids.filter((_, i) => !found[i]) };
  }
  const all = await provider.listAll();
  return { targets: 'user' in sel ? all.filter((c) => ownedBy(c, sel.user)) : all, missing: [] };
}

/** opensource-server with owner=email (and no default_owner) maps the email to an account. */
function needsEmail(env: NodeJS.ProcessEnv): boolean {
  try {
    const u = new URL(env.PROVIDER_URI ?? '');
    return u.protocol === 'opensource-server:' && u.searchParams.get('owner') === 'email' && !u.searchParams.get('default_owner');
  } catch {
    return false;
  }
}

function summary(deps: AdminDeps, results: Array<{ outcome: string }>) {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  deps.err(`summary: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do'}`);
}

// ---- commands

async function list(deps: AdminDeps, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { user: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  let all = await deps.provider.listAll();
  if (values.user) all = all.filter((c) => ownedBy(c, values.user!));
  printComputers(deps, await probe(all, deps.probeTimeoutMs ?? 5000), !!values.json);
  return 0;
}

async function create(deps: AdminDeps, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      user: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' },
      wait: { type: 'boolean' }, timeout: { type: 'string' }, json: { type: 'boolean' },
    },
  });
  if (!values.user) throw new UsageError('create needs --user <id>');
  if (values.id !== undefined && !validId(values.id)) throw new UsageError(`--id must be a DNS label (${ID_PATTERN.source})`);
  if (!values.email && needsEmail(deps.env)) throw new UsageError('this provider (opensource-server, owner=email) needs --email <email>');
  const timeoutMs = values.timeout ? parseDuration(values.timeout) : 5 * 60_000;
  const { provider } = deps;

  if (values.id !== undefined && await provider.get(values.id)) {
    deps.err(`a computer with id ${values.id} already exists`);
    return 1;
  }
  const raw = deps.env.ORCHESTRATOR_MAX_INSTANCES;
  if (raw && /^\d+$/.test(raw)) {
    const have = (await provider.list(values.user)).length;
    if (have >= Number(raw)) deps.err(`warning: ${values.user} already has ${have} computer(s); ORCHESTRATOR_MAX_INSTANCES is ${raw} (not enforced for admins)`);
  }

  const owner = { id: values.user, email: values.email, name: undefined };
  const record = { action: 'create', user: values.email || values.user, requested_id: values.id ?? null, display_name: values.name ?? null };
  let c: Computer;
  try {
    c = await provider.create({ owner, displayName: values.name, id: values.id });
  } catch (e) {
    deps.audit({ ...record, outcome: 'failed', error: (e as Error).message }, 'admin create failed');
    deps.err(`create failed: ${(e as Error).message}`);
    return 1;
  }
  deps.audit({ ...record, instance: c.id, outcome: 'created' }, 'admin create');
  let ready: boolean | undefined;
  if (values.wait) ({ c, ready } = await waitReady(provider, c, timeoutMs, true, deps.readyIntervalMs ?? 1500));
  if (values.json) deps.out(JSON.stringify({ ...asJson({ c }), ...(ready === undefined ? {} : { ready }) }));
  else {
    printComputers(deps, [{ c }], false);
    if (ready !== undefined) deps.err(ready ? `${c.id} is ready` : `${c.id} is not ready yet (status: ${c.status})`);
  }
  return ready === false ? 1 : 0;
}

async function remove(deps: AdminDeps, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args, strict: true,
    options: { id: { type: 'string', multiple: true }, user: { type: 'string' }, all: { type: 'boolean' }, yes: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const sel = selection(values);
  const batch = !('ids' in sel);
  const { targets, missing } = await select(deps.provider, sel);
  for (const id of missing) deps.err(`no computer ${id}`);
  if (!targets.length) { deps.err('no computers to delete'); return missing.length ? 1 : 0; }

  // Show what will go, and who would be cut off.
  const shown = await probe(targets, deps.probeTimeoutMs ?? 5000);
  if (!values.json) printComputers(deps, shown, false);
  if (batch && !values.yes) {
    if (!deps.prompt) throw new UsageError('deleting by --user or --all needs --yes (or a terminal to confirm on)');
    const want = `delete ${targets.length}`;
    const answer = await deps.prompt(`Type "${want}" to delete these ${targets.length} computer(s): `);
    if (answer.trim() !== want) { deps.err('not confirmed; nothing deleted'); return 1; }
  }

  const results = await pool(targets, 4, async (c) => {
    try {
      await deps.provider.destroy(c.id);
      deps.audit({ action: 'delete', instance: c.id, owner: observedOwner(c), outcome: 'deleted' }, 'admin delete');
      return { id: c.id, outcome: 'deleted' };
    } catch (e) {
      deps.audit({ action: 'delete', instance: c.id, owner: observedOwner(c), outcome: 'failed', error: (e as Error).message }, 'admin delete failed');
      return { id: c.id, outcome: 'failed', error: (e as Error).message };
    }
  });
  const all = [...results, ...missing.map((id) => ({ id, outcome: 'not found' }))];
  for (const r of all) deps.out(values.json ? JSON.stringify(r) : `${r.id}: ${r.outcome}${'error' in r && r.error ? ` (${r.error})` : ''}`);
  summary(deps, all);
  return all.every((r) => r.outcome === 'deleted') ? 0 : 1;
}

export interface UpdateResult {
  id: string;
  outcome: 'updated' | 'unchanged' | 'current' | 'stopped' | 'unsupported' | 'in use' | 'failed' | 'timeout' | 'not found';
  before?: string | null;
  after?: string | null;
  detail?: string;
  log?: string;
}
const UPDATE_OK = new Set<UpdateResult['outcome']>(['updated', 'unchanged', 'current']);
const TERMINAL = new Set(['succeeded', 'unchanged', 'failed']);

async function updateOne(deps: AdminDeps, c: Computer, o: { force: boolean; timeoutMs: number }): Promise<UpdateResult> {
  const base = { id: c.id };
  if (c.stopped) return { ...base, outcome: 'stopped', detail: settling(c) ? 'still starting' : `status ${c.status}` };
  let api: ComputerApi;
  try { api = new ComputerApi(c); } catch (e) { return { ...base, outcome: 'failed', detail: (e as Error).message }; }
  const deadline = Date.now() + o.timeoutMs;
  let before: string | null = null;
  let applied: UpdateStatus | null = null;
  try {
    const status = await api.updateStatus();
    before = status.current;
    if (!status.supported) return { ...base, outcome: 'unsupported', before, detail: status.limitation ?? 'updates are not supported' };
    if (!['requested', 'running'].includes(status.upgrade?.state)) {
      const checked = await api.checkUpdate();
      before = checked.current ?? before;
      if (checked.error && !checked.available) return { ...base, outcome: 'failed', before, detail: `update check failed: ${checked.error}` };
      if (!checked.available) return { ...base, outcome: 'current', before };
      const people = await api.presence();
      if (people.length && !o.force) {
        return { ...base, outcome: 'in use', before, detail: `connected: ${people.map(describePerson).join(', ')} (use --force)` };
      }
      deps.audit({ action: 'update', instance: c.id, owner: observedOwner(c), from: before, to: checked.latest, forced: people.length > 0, outcome: 'requested' }, 'admin update');
      applied = await api.applyUpdate();
    } else {
      applied = status; // already upgrading: wait on it
    }
  } catch (e) {
    return { ...base, outcome: 'failed', before, detail: (e as Error).message };
  }

  // Poll until a terminal state. The server restarts during the upgrade, so connection
  // errors are expected and retried. A terminal state equal to the one before applying
  // (same state and time) is stale and not taken as the result.
  const stale = TERMINAL.has(applied.upgrade?.state) ? `${applied.upgrade.state}@${applied.upgrade.at}` : null;
  let last: UpdateStatus | null = null;
  while (Date.now() < deadline) {
    await sleep(Math.min(deps.pollMs ?? 3000, Math.max(0, deadline - Date.now())));
    try { last = await api.updateStatus(); } catch { continue; }
    const st = last.upgrade?.state;
    if (!TERMINAL.has(st) || `${st}@${last.upgrade.at}` === stale) continue;
    const r = { ...base, before, after: last.current };
    const finish = (res: UpdateResult) => {
      deps.audit({ action: 'update', instance: c.id, owner: observedOwner(c), from: before, to: last!.current, outcome: res.outcome }, 'admin update finished');
      return res;
    };
    if (st === 'succeeded') return finish({ ...r, outcome: 'updated' });
    if (st === 'unchanged') return finish({ ...r, outcome: 'unchanged' });
    return finish({ ...r, outcome: 'failed', detail: 'upgrade failed', log: last.upgrade.log ?? '' });
  }
  deps.audit({ action: 'update', instance: c.id, owner: observedOwner(c), from: before, outcome: 'timeout' }, 'admin update timed out');
  return { ...base, outcome: 'timeout', before, detail: `no result after ${Math.round(o.timeoutMs / 1000)} s (last state: ${last?.upgrade?.state ?? 'unreachable'})`, log: last?.upgrade?.log };
}

const tail = (log: string, lines = 15) => log.trimEnd().split('\n').slice(-lines).map((l) => `    ${l}`).join('\n');

async function update(deps: AdminDeps, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      id: { type: 'string', multiple: true }, user: { type: 'string' }, all: { type: 'boolean' },
      parallel: { type: 'string' }, timeout: { type: 'string' }, force: { type: 'boolean' }, json: { type: 'boolean' },
    },
  });
  const sel = selection(values);
  const parallel = values.parallel === undefined ? 4 : Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) throw new UsageError('--parallel must be a positive integer');
  const timeoutMs = values.timeout ? parseDuration(values.timeout) : 15 * 60_000;
  const { targets, missing } = await select(deps.provider, sel);
  if (!targets.length && !missing.length) { deps.err('no computers to update'); return 0; }

  const report = (r: UpdateResult) => {
    if (values.json) { deps.out(JSON.stringify(r)); return; }
    const versions = r.outcome === 'updated' || r.outcome === 'unchanged' ? ` (${r.before ?? '?'} -> ${r.after ?? '?'})`
      : r.outcome === 'current' ? ` (${r.before ?? '?'})` : '';
    deps.out(`${r.id}: ${r.outcome}${versions}${r.detail ? `: ${r.detail}` : ''}`);
    if (r.log) deps.out(tail(r.log));
  };
  const results = await pool(targets, parallel, async (c) => {
    const r = await updateOne(deps, c, { force: !!values.force, timeoutMs });
    report(r); // as each finishes: updates take minutes
    return r;
  });
  for (const id of missing) { const r: UpdateResult = { id, outcome: 'not found' }; report(r); results.push(r); }
  summary(deps, results);
  return results.every((r) => UPDATE_OK.has(r.outcome)) ? 0 : 1;
}

const COMMANDS: Record<string, (deps: AdminDeps, args: string[]) => Promise<number>> = { list, create, delete: remove, update };

/** Run one admin command; returns the exit code. */
export async function runAdmin(argv: string[], deps: AdminDeps): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    (command ? deps.out : deps.err)(USAGE);
    return command ? 0 : 2;
  }
  const fn = COMMANDS[command];
  if (!fn) { deps.err(`unknown command ${command}\n${USAGE}`); return 2; }
  return tracer.startActiveSpan(`admin ${command}`, { attributes: { 'ozwell.provider': deps.provider.scheme } }, async (span) => {
    try {
      const code = await fn(deps, args);
      span.setAttribute('process.exit.code', code);
      return code;
    } catch (e) {
      // parseArgs' own errors (unknown option, missing value) are usage errors too.
      if (e instanceof UsageError || (e as any)?.code?.startsWith?.('ERR_PARSE_ARGS')) {
        deps.err(`${(e as Error).message}\n${USAGE}`);
        span.setAttribute('process.exit.code', 2);
        return 2;
      }
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      deps.err(`error: ${e instanceof InstanceError ? `${e.reason}: ` : ''}${(e as Error).message}`);
      return 1;
    } finally {
      span.end();
    }
  });
}

async function main() {
  const { createInterface } = await import('node:readline/promises');
  const { default: pino } = await import('pino');
  const { providerFromUri } = await import('./providers/index.ts');
  const { instrumentProvider } = await import('./instrument-provider.ts');
  const { shutdownTelemetry } = await import('./telemetry.ts');
  const env = process.env;
  const exit = async (code: number) => { await shutdownTelemetry(); process.exit(code); };
  if (!env.PROVIDER_URI) {
    process.stderr.write('admin: PROVIDER_URI is required (it uses the orchestrator\'s configuration; see orchestrator/README.md)\n');
    return exit(2);
  }
  let provider: Provider;
  try {
    provider = instrumentProvider(await providerFromUri(env.PROVIDER_URI, env));
  } catch (e) {
    process.stderr.write(`admin: ${(e as Error).message}\n`);
    return exit(2);
  }
  // Audit lines on stderr, so stdout stays clean for --json.
  const log = pino({ name: 'ozwell-computer-admin', level: 'info', base: { component: 'admin', operator: env.SUDO_USER || env.USER || null } }, pino.destination(2));
  const tty = process.stdin.isTTY && process.stderr.isTTY;
  const code = await runAdmin(process.argv.slice(2), {
    provider, env,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    audit: (record, msg) => log.info(record, msg),
    prompt: tty ? async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return await rl.question(q); } finally { rl.close(); }
    } : undefined,
  });
  log.flush();
  return exit(code);
}

if (import.meta.main) await main();
