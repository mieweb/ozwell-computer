// Opt-in Docker/CRIU lifecycle. Immutable labels identify the computer; atomic
// names record save intent, and separate worker containers retain API receipts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DockerApi, DockerProvider } from './docker.ts';
import { CheckpointLock } from './checkpoint-lock.ts';
import { generateId, type Computer, type CreateOptions, type ProviderFactory } from './types.ts';

const L = 'org.mieweb.ozwell-computer.';
const ID = /^ozc-[a-z2-7]{10}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const architectures: Record<string, string> = { aarch64: 'arm64', x86_64: 'amd64' };
const nativeArchitecture = (arch: unknown) => architectures[String(arch)] ?? String(arch);
const workerCode = readFileSync(new URL('./checkpoint-worker.mjs', import.meta.url), 'utf8');
interface Phase { kind: 'saving' | 'saved' | 'restoring'; generation: string }
interface Dependencies {
  api?: DockerApi;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  guestPrepared?: (computer: Computer) => Promise<boolean>;
}

export class DockerCheckpointProvider extends DockerProvider {
  override readonly scheme = 'docker-checkpoint';
  readonly publicUrl: string;
  readonly workerImage: string;
  readonly networkImage: string;
  readonly criuConfig: string;
  readonly daemonSocket: string;
  readonly lockDirectory: string;
  readonly jobTimeoutMs: number;
  private readonly engine: DockerApi;
  private readonly lockHost: NonNullable<Dependencies['lock']>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly prepared: NonNullable<Dependencies['guestPrepared']>;
  private context = new AsyncLocalStorage<boolean>();
  private queue: Promise<void> = Promise.resolve();
  private needsReap = true;

  constructor(uri: URL, env: NodeJS.ProcessEnv = process.env, deps: Dependencies = {}) {
    super(uri, env);
    // Shared local locking is insufficient for controllers on unrelated hosts.
    if (uri.hostname) throw new Error('docker-checkpoint requires a local Docker UNIX socket');
    this.publicUrl = env.COMPUTER_GATEWAY_URL ?? env.DOCKER_CHECKPOINT_PUBLIC_URL ?? '';
    const replaced = this.publicUrl.replace('{id}', 'ozc-placeholder');
    let origin: URL;
    try { origin = new URL(replaced); } catch { throw new Error('computer gateway URL must contain an {id} DNS label'); }
    if (this.publicUrl.split('{id}').length !== 2 || !origin.hostname.split('.').includes('ozc-placeholder') || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) throw new Error('computer gateway URL must be an http(s) origin with one complete {id} DNS label');
    this.workerImage = env.DOCKER_CHECKPOINT_WORKER_IMAGE ?? 'node:24-bookworm-slim';
    this.networkImage = env.DOCKER_CHECKPOINT_NETWORK_IMAGE ?? 'alpine:3.19';
    this.criuConfig = env.DOCKER_CHECKPOINT_CRIU_CONFIG ?? '/opt/ozc-criu/ozwell.conf';
    if (!this.criuConfig.startsWith('/') || this.criuConfig.includes('\0')) throw new Error('DOCKER_CHECKPOINT_CRIU_CONFIG must be an absolute daemon-host path without NUL bytes');
    this.daemonSocket = env.DOCKER_CHECKPOINT_DAEMON_SOCKET ?? '/var/run/docker.sock';
    if (!this.daemonSocket.startsWith('/') || this.daemonSocket.includes(':')) throw new Error('DOCKER_CHECKPOINT_DAEMON_SOCKET must be an absolute daemon-host path without colons');
    this.lockDirectory = resolve(env.DOCKER_CHECKPOINT_LOCK_DIR ?? join(homedir(), '.local/state/ozwell-computer/checkpoints'));
    this.jobTimeoutMs = Number(env.DOCKER_CHECKPOINT_JOB_TIMEOUT_MS ?? 120_000);
    if (!Number.isSafeInteger(this.jobTimeoutMs) || this.jobTimeoutMs < 1 || this.jobTimeoutMs > 300_000) throw new Error('DOCKER_CHECKPOINT_JOB_TIMEOUT_MS must be 1..300000');
    this.engine = deps.api ?? new DockerApi(this.api.target, Math.min(this.jobTimeoutMs, 10_000));
    const lock = new CheckpointLock(this.lockDirectory);
    this.lockHost = deps.lock ?? ((fn) => lock.run(fn));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.prepared = deps.guestPrepared ?? (async (c) => {
      if (!c.internalUrl || !c.token) return false;
      const r = await fetch(`${c.internalUrl}/api/v1/lifecycle`, { headers: { authorization: `Bearer ${c.token}`, connection: 'close' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { await r.body?.cancel(); return false; }
      const state = await r.json() as { prepared?: boolean; busy?: boolean; active_requests?: number; connections?: number; running_jobs?: number; leases?: number };
      return state.prepared === true && state.busy === false && state.active_requests === 0 && state.connections === 0 && state.running_jobs === 0 && state.leases === 0;
    });
  }

  private labels(raw: any) { return raw.Config?.Labels ?? {}; }
  private validate(raw: any): boolean {
    const l = this.labels(raw);
    if (l[`${L}managed`] !== 'true' || l[`${L}checkpoint-version`] !== '1') return false;
    if (!FULL_ID.test(raw.Id) || !ID.test(l[`${L}instance-id`] ?? '') || !l[`${L}owner`] || !l[`${L}gateway-url`]) throw new Error('invalid checkpoint computer identity');
    if (l[`${L}checkpoint-profile`] !== 'flat-v1' || raw.HostConfig?.CgroupnsMode === 'host' || raw.HostConfig?.Binds?.some((bind: string) => bind.split(':')[1] === '/sys/fs/cgroup')) throw new Error('checkpoint computer requires the flat-v1 private-cgroup profile');
    const config = l[`${L}criu-config`];
    if (typeof config !== 'string' || !config.startsWith('/') || config.includes('\0') || raw.HostConfig?.Annotations?.['org.criu.config'] !== config) throw new Error('checkpoint computer CRIU configuration annotation mismatch');
    if (!FULL_ID.test(l[`${L}network-anchor`] ?? '') || !l[`${L}network-image`] || raw.HostConfig?.NetworkMode !== `container:${l[`${L}network-anchor`]}`) throw new Error('invalid checkpoint network anchor binding');
    if (raw.Config?.Tty || raw.HostConfig?.AutoRemove || !['no', ''].includes(raw.HostConfig?.RestartPolicy?.Name ?? '')) throw new Error('checkpoint computer has unsafe terminal/restart configuration');
    this.phase(raw); // Unknown names must never silently lose saved-state intent.
    return true;
  }
  private phase(raw: any): Phase | null {
    const id = this.labels(raw)[`${L}instance-id`], name = String(raw.Name ?? '').replace(/^\//, '');
    if (name === id) return null;
    const match = name.match(new RegExp(`^${id}--(saving|saved|restoring)-([a-f0-9]{16})$`));
    if (!match) throw new Error(`invalid checkpoint transaction name for ${id}`);
    return { kind: match[1] as Phase['kind'], generation: match[2] };
  }
  private async raw(id: string): Promise<any | null> {
    if (!ID.test(id) && !FULL_ID.test(id)) return null;
    let r: { status: number; data: any };
    if (ID.test(id)) {
      const filters = encodeURIComponent(JSON.stringify({ label: [`${L}checkpoint-version=1`, `${L}instance-id=${id}`, `${L}managed=true`] }));
      const matches = await this.engine.ok('GET', `/containers/json?all=1&filters=${filters}`);
      if (!Array.isArray(matches) || matches.length > 1) throw new Error(`ambiguous checkpoint computer ${id}`);
      if (!matches.length) return null;
      r = await this.engine.call('GET', `/containers/${matches[0].Id}/json`);
    } else r = await this.engine.call('GET', `/containers/${id}/json`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`docker inspect ${id}: HTTP ${r.status}`);
    if (!this.validate(r.data)) return null;
    // The application shares the anchor's namespace; its own NetworkSettings do
    // not describe the routable bridge endpoint or published ports.
    r.data.NetworkSettings = (await this.anchor(r.data)).NetworkSettings;
    return r.data;
  }
  private async anchor(raw: any): Promise<any> {
    const labels = this.labels(raw), id = labels[`${L}network-anchor`];
    if (!FULL_ID.test(id ?? '')) throw new Error('invalid checkpoint network anchor identity');
    const r = await this.engine.call('GET', `/containers/${id}/json`);
    if (r.status !== 200) throw new Error(`checkpoint network anchor unavailable: HTTP ${r.status}`);
    const a = r.data, l = this.labels(a);
    if (a.Id !== id || l[`${L}network-anchor-version`] !== '1' || l[`${L}instance-id`] !== labels[`${L}instance-id`] || l[`${L}owner`] !== labels[`${L}owner`] || a.Config?.Image !== labels[`${L}network-image`] || JSON.stringify(a.Config.Entrypoint) !== '["/bin/sleep"]' || JSON.stringify(a.Config.Cmd) !== '["infinity"]' || a.Config.Tty || a.HostConfig?.AutoRemove || a.HostConfig?.RestartPolicy?.Name !== 'unless-stopped') throw new Error('checkpoint network anchor ownership/configuration mismatch');
    return a;
  }
  private async startAnchor(raw: any) {
    const anchor = await this.anchor(raw);
    if (anchor.State?.Status === 'running') return;
    if (!['created', 'exited'].includes(anchor.State?.Status)) throw new Error('checkpoint network anchor is not startable');
    await this.engine.ok('POST', `/containers/${anchor.Id}/start`);
    if ((await this.anchor(raw)).State?.Status !== 'running') throw new Error('checkpoint network anchor did not start');
  }
  private require(raw: any, id: string) { if (!raw) throw new Error(`computer ${id} not found`); return raw; }
  protected override toComputer(raw: any): Computer {
    const base = super.toComputer(raw), labels = this.labels(raw), phase = this.phase(raw);
    return { ...base, id: labels[`${L}instance-id`], externalUrl: labels[`${L}gateway-url`], hibernated: !!phase,
      status: phase ? (base.stopped ? 'hibernated' : phase.kind) : base.status };
  }
  override async get(id: string): Promise<Computer | null> { const raw = await this.raw(id); return raw ? this.toComputer(raw) : null; }
  async listAll(): Promise<Computer[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${L}managed=true`, `${L}checkpoint-version=1`] }));
    const rows = await this.engine.ok('GET', `/containers/json?all=1&filters=${filters}`);
    const out = await Promise.all(rows.map((r: any) => this.get(r.Id)));
    return out.filter((c: Computer | null): c is Computer => !!c);
  }
  override async list(owner: string) { return (await this.listAll()).filter((c) => c.owner === owner); }

  private async rename(raw: any, phase: Phase | null) {
    const id = this.labels(raw)[`${L}instance-id`];
    const name = phase ? `${id}--${phase.kind}-${phase.generation}` : id;
    await this.engine.ok('POST', `/containers/${raw.Id}/rename?name=${encodeURIComponent(name)}`);
  }
  private workerName(raw: any, phase: Phase, operation: 'save' | 'restore') { return `ozc-op-${raw.Id.slice(0, 16)}-${phase.generation}-${operation}`; }
  private async worker(raw: any, phase: Phase, operation: 'save' | 'restore'): Promise<any | null> {
    const name = this.workerName(raw, phase, operation), r = await this.engine.call('GET', `/containers/${name}/json`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`cannot inspect checkpoint worker: HTTP ${r.status}`);
    const l = r.data?.Config?.Labels ?? {};
    const config = r.data?.Config, env = new Map<string, string>((config?.Env ?? []).map((s: string) => { const at = s.indexOf('='); return [s.slice(0, at), s.slice(at + 1)]; }));
    if (!FULL_ID.test(r.data?.Id) || l[`${L}operation-version`] !== '1' || l[`${L}target`] !== raw.Id || l[`${L}owner`] !== this.labels(raw)[`${L}owner`] || l[`${L}instance-id`] !== this.labels(raw)[`${L}instance-id`] || l[`${L}generation`] !== phase.generation || l[`${L}operation`] !== operation || config?.Image !== this.workerImage || JSON.stringify(config.Entrypoint) !== '["node"]' || JSON.stringify(config.Cmd) !== JSON.stringify(['--input-type=module', '-e', workerCode]) || env.get('TARGET_ID') !== raw.Id || env.get('CHECKPOINT_ID') !== `ozc-${phase.generation}` || env.get('OPERATION') !== operation || env.has('ENGINE_SOCKET') || config.Tty || r.data.HostConfig?.AutoRemove || !['', 'no'].includes(r.data.HostConfig?.RestartPolicy?.Name ?? '')) throw new Error('checkpoint worker identity/configuration mismatch');
    return r.data;
  }
  private async ensureWorker(raw: any, phase: Phase, operation: 'save' | 'restore') {
    let worker = await this.worker(raw, phase, operation);
    if (!worker) {
      const name = this.workerName(raw, phase, operation);
      const r = await this.engine.call('POST', `/containers/create?name=${name}`, {
        Image: this.workerImage, Entrypoint: ['node'], Cmd: ['--input-type=module', '-e', workerCode], Tty: false,
        Env: [`TARGET_ID=${raw.Id}`, `CHECKPOINT_ID=ozc-${phase.generation}`, `OPERATION=${operation}`],
        Labels: { [`${L}operation-version`]: '1', [`${L}target`]: raw.Id, [`${L}owner`]: this.labels(raw)[`${L}owner`], [`${L}instance-id`]: this.labels(raw)[`${L}instance-id`], [`${L}generation`]: phase.generation, [`${L}operation`]: operation },
        HostConfig: { AutoRemove: false, RestartPolicy: { Name: 'no' }, NetworkMode: 'none', Binds: [`${this.daemonSocket}:/engine.sock:rw`], ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] },
      });
      if (r.status !== 201 && r.status !== 409) throw new Error(`cannot create checkpoint worker (pre-pull ${this.workerImage}): HTTP ${r.status}`);
      worker = this.require(await this.worker(raw, phase, operation), name);
    }
    if (worker.State?.Status === 'created') {
      // A late atomic rename can be discovered after another controller already
      // reopened a previously normal guest. Do not start a new save unless its
      // admission gate is still closed. Existing running operations are awaited.
      if (operation === 'save' && !await this.prepared(this.toComputer(raw))) throw new Error('guest is no longer prepared; retaining checkpoint intent and closed admission');
      if (operation === 'restore') await this.startAnchor(raw);
      await this.engine.ok('POST', `/containers/${worker.Id}/start`);
    }
  }
  private async receipt(raw: any, phase: Phase, operation: 'save' | 'restore'): Promise<0 | 64> {
    await this.ensureWorker(raw, phase, operation);
    const deadline = this.now() + this.jobTimeoutMs;
    for (;;) {
      const worker = this.require(await this.worker(raw, phase, operation), 'checkpoint worker');
      if (worker.State?.Status === 'exited') {
        if (worker.State.OOMKilled || ![0, 64].includes(worker.State.ExitCode)) throw new Error('checkpoint worker outcome is ambiguous; retaining state and closed admission');
        return worker.State.ExitCode;
      }
      if (!['running', 'created'].includes(worker.State?.Status)) throw new Error('checkpoint worker state is unknown; retaining closed admission');
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new Error('checkpoint operation still running; retaining state and closed admission');
      await this.sleep(Math.min(250, remaining));
    }
  }
  private async waitTarget(raw: any, running: boolean): Promise<any> {
    const deadline = this.now() + this.jobTimeoutMs;
    for (;;) {
      const current = this.require(await this.raw(raw.Id), raw.Id);
      if (current.State?.Status === (running ? 'running' : 'exited') && (running || current.State?.Pid === 0)) return current;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new Error('checkpoint target did not reach expected state; retaining closed admission');
      await this.sleep(Math.min(250, remaining));
    }
  }
  private async checkpoints(raw: any): Promise<string[]> {
    const rows = await this.engine.ok('GET', `/containers/${raw.Id}/checkpoints`);
    if (!Array.isArray(rows)) throw new Error('invalid checkpoint listing');
    return rows.map((r: any) => r.Name);
  }
  private async cleanupWorker(raw: any, phase: Phase, operation: 'save' | 'restore') {
    const worker = await this.worker(raw, phase, operation);
    if (worker?.State?.Status === 'exited' && [0, 64].includes(worker.State.ExitCode) && !worker.State.OOMKilled) await this.engine.ok('DELETE', `/containers/${worker.Id}?v=1`);
  }
  private async cleanupCommitted(raw: any) {
    // A crash can follow the atomic phase promotion but precede receipt cleanup.
    const filters = encodeURIComponent(JSON.stringify({ label: [`${L}operation-version=1`, `${L}target=${raw.Id}`] }));
    const rows = await this.engine.ok('GET', `/containers/json?all=1&filters=${filters}`);
    for (const row of rows) {
      const inspected = await this.engine.ok('GET', `/containers/${row.Id}/json`), labels = this.labels(inspected);
      const generation = labels[`${L}generation`], operation = labels[`${L}operation`];
      if (!/^[a-f0-9]{16}$/.test(generation ?? '') || !['save', 'restore'].includes(operation)) throw new Error('invalid orphan checkpoint receipt');
      const phase: Phase = { kind: 'restoring', generation };
      const worker = this.require(await this.worker(raw, phase, operation), 'checkpoint receipt');
      const completed = worker.State?.Status === 'exited' && !worker.State.OOMKilled;
      if (completed && operation === 'restore' && worker.State.ExitCode === 0) {
        if ((await this.checkpoints(raw)).includes(`ozc-${generation}`)) await this.engine.ok('DELETE', `/containers/${raw.Id}/checkpoints/ozc-${generation}`);
        await this.cleanupWorker(raw, phase, operation);
      } else if (completed && operation === 'save' && worker.State.ExitCode === 64) await this.cleanupWorker(raw, phase, operation);
      else throw new Error('checkpoint worker exists without matching durable intent; retaining closed admission');
    }
  }
  private async settle(id: string) {
    const raw = await this.raw(id); if (!raw) return;
    const phase = this.phase(raw); if (!phase) { await this.cleanupCommitted(raw); return; }
    if (phase.kind === 'saved') { await this.cleanupWorker(raw, phase, 'save'); return; }
    const operation = phase.kind === 'saving' ? 'save' : 'restore';
    const result = await this.receipt(raw, phase, operation);
    if (operation === 'save') {
      if (result === 64) { await this.waitTarget(raw, true); await this.rename(raw, null); await this.cleanupWorker(raw, phase, 'save'); return; }
      await this.waitTarget(raw, false);
      if (!(await this.checkpoints(raw)).includes(`ozc-${phase.generation}`)) throw new Error('completed checkpoint is missing; refusing cold boot');
      await this.rename(raw, { ...phase, kind: 'saved' });
      await this.cleanupWorker(raw, phase, 'save');
    } else if (result === 0) {
      await this.waitTarget(raw, true);
      // The restored workload has resumed: this old checkpoint must never rewind
      // a later crash. Clear intent atomically before consuming its old RAM image.
      await this.rename(raw, null);
      await this.engine.ok('DELETE', `/containers/${raw.Id}/checkpoints/ozc-${phase.generation}`);
      await this.cleanupWorker(raw, phase, 'restore');
    } else {
      // A completed HTTP failure can be retried, only after the target is stopped.
      await this.waitTarget(raw, false);
    }
  }
  private async reapOrphans() {
    // Read every state, including saved/exited mains and foreign namespace users.
    // A missing main is the only evidence that its marked workers/anchor may go.
    const rows = await this.engine.ok('GET', '/containers/json?all=1');
    const all: any[] = [];
    for (const row of rows) {
      if (!FULL_ID.test(row.Id)) throw new Error('invalid Docker identity during orphan reconciliation');
      const r = await this.engine.call('GET', `/containers/${row.Id}/json`);
      if (r.status === 404) continue;
      if (r.status !== 200 || r.data?.Id !== row.Id) throw new Error('cannot establish container ownership during orphan reconciliation');
      all.push(r.data);
    }
    const references = new Set<string>();
    let unresolvedReference = false;
    for (const raw of all) {
      const labels = this.labels(raw), mode = raw.HostConfig?.NetworkMode;
      if (typeof mode === 'string' && mode.startsWith('container:')) {
        const target = mode.slice('container:'.length);
        if (FULL_ID.test(target)) references.add(target);
        else {
          // Docker keeps names and short ID prefixes in NetworkMode. Resolve
          // them through the engine rather than overlooking a foreign sharer.
          const resolved = await this.engine.call('GET', `/containers/${encodeURIComponent(target)}/json`);
          if (resolved.status === 404) unresolvedReference = true;
          else if (resolved.status !== 200 || !FULL_ID.test(resolved.data?.Id)) throw new Error('cannot resolve shared network namespace ownership');
          else references.add(resolved.data.Id);
        }
      }
      if (labels[`${L}managed`] === 'true' && labels[`${L}checkpoint-version`] === '1') {
        const anchor = labels[`${L}network-anchor`];
        if (!FULL_ID.test(anchor ?? '')) throw new Error('cannot establish managed namespace references');
        references.add(anchor);
      }
    }
    for (const raw of all) {
      const labels = this.labels(raw), target = labels[`${L}target`], generation = labels[`${L}generation`], operation = labels[`${L}operation`];
      if (labels[`${L}operation-version`] !== '1' || !labels[`${L}owner`] || !ID.test(labels[`${L}instance-id`] ?? '') || !FULL_ID.test(target ?? '') || !/^[a-f0-9]{16}$/.test(generation ?? '') || !['save', 'restore'].includes(operation) || raw.Name !== `/ozc-op-${target.slice(0, 16)}-${generation}-${operation}`) continue;
      const found = await this.engine.call('GET', `/containers/${target}/json`);
      if (found.status === 200) continue;
      if (found.status !== 404) throw new Error('cannot verify checkpoint worker target is absent');
      await this.engine.ok('DELETE', `/containers/${raw.Id}?force=1&v=1`);
    }
    // A disappearing or renamed foreign target leaves ownership uncertain.
    // Retain anchors until a later reconciliation can establish every reference.
    if (unresolvedReference) return;
    for (const raw of all) {
      const labels = this.labels(raw), id = labels[`${L}instance-id`];
      if (labels[`${L}network-anchor-version`] !== '1' || !ID.test(id ?? '') || !labels[`${L}owner`] || !labels[`${L}network-image`] || raw.Name !== `/ozc-net-${id}` || references.has(raw.Id)) continue;
      const expected = { Config: { Labels: { ...labels, [`${L}network-anchor`]: raw.Id } } };
      const owned = await this.anchor(expected);
      await this.engine.ok('DELETE', `/containers/${owned.Id}?force=1&v=1`);
    }
  }
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) { await this.settle(id); return fn(); }
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>((r) => { release = r; }); await previous;
    try { return await this.lockHost(() => this.context.run(true, async () => { if (this.needsReap) { await this.reapOrphans(); this.needsReap = false; } await this.settle(id); return fn(); })); }
    finally { release(); }
  }

  override async create(opts: CreateOptions): Promise<Computer> {
    return this.withLock('create', async () => {
      if (!opts.owner.id) throw new Error('owner id is required');
      const id = generateId(), token = randomBytes(24).toString('base64url');
      const info = await this.engine.call('GET', '/info');
      if (info.status !== 200 || !info.data?.Architecture || info.data.OSType !== 'linux') throw new Error('checkpoint computers require a Linux Docker engine with a known native architecture');
      const source = await this.engine.call('GET', `/images/${encodeURIComponent(this.image)}/json`);
      if (source.status !== 200 || !IMAGE_ID.test(source.data?.Id)) throw new Error(`pre-pull the native flat-v1 checkpoint image ${this.image}`);
      if (source.data.Os !== 'linux' || nativeArchitecture(source.data.Architecture) !== nativeArchitecture(info.data.Architecture)) throw new Error(`checkpoint image must match the engine native architecture (${info.data.Architecture}); emulated images cannot retain process state`);
      if (source.data.Config?.Labels?.[`${L}checkpoint-profile`] !== 'flat-v1') throw new Error('checkpoint image profile flat-v1 is required; build the dedicated checkpoint image instead of using the ordinary systemd image');
      const image = await this.engine.call('GET', `/images/${encodeURIComponent(this.networkImage)}/json`);
      if (image.status !== 200 || !image.data?.Id) throw new Error(`pre-pull the checkpoint network image ${this.networkImage}`);
      const createdAnchor = await this.engine.call('POST', `/containers/create?name=ozc-net-${id}`, {
        Image: this.networkImage, Hostname: id, Entrypoint: ['/bin/sleep'], Cmd: ['infinity'], Tty: false,
        Labels: { [`${L}network-anchor-version`]: '1', [`${L}instance-id`]: id, [`${L}owner`]: opts.owner.id, [`${L}network-image`]: this.networkImage },
        ExposedPorts: { '8080/tcp': {} },
        HostConfig: { AutoRemove: false, RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: this.network ?? 'default', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
          ...(this.publish ? { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } } : {}) },
      });
      if (createdAnchor.status !== 201 || !FULL_ID.test(createdAnchor.data?.Id)) throw new Error(`cannot create checkpoint network anchor: HTTP ${createdAnchor.status}`);
      const anchorId = createdAnchor.data.Id;
      let defined = false, ambiguousCreate = false;
      try {
      await this.engine.ok('POST', `/containers/${anchorId}/start`);
      let r: { status: number; data: any };
      try { r = await this.engine.call('POST', `/containers/create?name=${id}`, {
        // Pin the inspected image digest so a moving tag cannot bypass preflight.
        Image: source.data.Id, Tty: false,
        Env: Object.entries({ ...this.env, UV_USE_IO_URING: '0', OZWELL_COMPUTER_TOKEN: token }).map(([k, v]) => `${k}=${v}`),
        Labels: { [`${L}managed`]: 'true', [`${L}checkpoint-version`]: '1', [`${L}checkpoint-profile`]: 'flat-v1', [`${L}criu-config`]: this.criuConfig, [`${L}instance-id`]: id, [`${L}network-anchor`]: anchorId, [`${L}network-image`]: this.networkImage, [`${L}gateway-url`]: this.publicUrl.replace('{id}', id).replace(/\/$/, ''), [`${L}owner`]: opts.owner.id,
          [`${L}display-name`]: opts.displayName ?? '', [`${L}owner-email`]: opts.owner.email ?? '', [`${L}owner-name`]: opts.owner.name ?? '', [`${L}created`]: new Date().toISOString() },
        StopSignal: 'SIGTERM',
        HostConfig: { AutoRemove: false, RestartPolicy: { Name: 'no' }, Tmpfs: { '/run': '', '/run/lock': '' }, ShmSize: 1024 ** 3, Annotations: { 'org.criu.config': this.criuConfig },
          NetworkMode: `container:${anchorId}` },
      }); } catch (error) { ambiguousCreate = true; throw error; }
      if (r.status === 201 && !FULL_ID.test(r.data?.Id)) ambiguousCreate = true;
      if (r.status !== 201 || !FULL_ID.test(r.data?.Id)) throw new Error(`docker checkpoint create: HTTP ${r.status}; pre-pull the configured computer image`);
      defined = true;
      await this.engine.ok('POST', `/containers/${r.data.Id}/start`);
      return this.toComputer(this.require(await this.raw(r.data.Id), id));
      } catch (error) {
        // Keep both resources after a defined/possibly-defined application: its
        // namespace can be needed for recovery. Remove only a known empty anchor.
        if (!defined && !ambiguousCreate) {
          const anchorOwner = { Config: { Labels: { [`${L}instance-id`]: id, [`${L}owner`]: opts.owner.id, [`${L}network-anchor`]: anchorId, [`${L}network-image`]: this.networkImage } } };
          const owned = await this.anchor(anchorOwner);
          await this.engine.ok('DELETE', `/containers/${owned.Id}?force=1&v=1`);
        }
        throw error;
      }
    });
  }
  async hibernate(id: string): Promise<Computer> {
    return this.withLock(id, async () => {
      const raw = this.require(await this.raw(id), id), phase = this.phase(raw);
      if (phase) { if (phase.kind === 'saved') return this.toComputer(raw); throw new Error('checkpoint restore requires recovery before another save'); }
      if (raw.State?.Status !== 'running') throw new Error(`computer ${id} is not running`);
      const next: Phase = { kind: 'saving', generation: randomBytes(8).toString('hex') };
      await this.rename(raw, next);
      const result = await this.receipt(raw, next, 'save');
      await this.settle(raw.Id);
      if (result !== 0) throw new Error('Docker checkpoint failed; running workload retained');
      return this.toComputer(this.require(await this.raw(raw.Id), id));
    });
  }
  override async start(id: string): Promise<Computer> {
    return this.withLock(id, async () => {
      let raw = this.require(await this.raw(id), id), phase = this.phase(raw);
      await this.startAnchor(raw);
      raw = this.require(await this.raw(raw.Id), id);
      if (!phase) {
        if (raw.State?.Status !== 'running') await this.engine.ok('POST', `/containers/${raw.Id}/start`);
      } else {
        if (!(await this.checkpoints(raw)).includes(`ozc-${phase.generation}`)) throw new Error('saved checkpoint is missing; refusing cold boot');
        if (phase.kind === 'restoring') {
          const worker = this.require(await this.worker(raw, phase, 'restore'), 'restore worker');
          if (worker.State?.Status !== 'exited' || worker.State.ExitCode !== 64) throw new Error('restore outcome is ambiguous; refusing cold boot');
          await this.engine.ok('POST', `/containers/${worker.Id}/start`);
        } else { phase = { ...phase, kind: 'restoring' }; await this.rename(raw, phase); }
        const result = await this.receipt(raw, phase, 'restore');
        if (result !== 0) throw new Error('Docker checkpoint restore failed; saved state retained');
        await this.settle(raw.Id);
      }
      raw = this.require(await this.raw(raw.Id), id); return this.toComputer(raw);
    });
  }
  override async destroy(id: string): Promise<void> {
    // Explicit deletion may remove an ambiguous transaction; it is the only
    // operation that intentionally discards a computer and its saved RAM.
    return this.withLock('destroy', async () => {
      const raw = await this.raw(id); if (!raw) { await this.reapOrphans(); return; }
      this.needsReap = true;
      const anchor = await this.anchor(raw);
      await this.engine.ok('DELETE', `/containers/${raw.Id}?force=1&v=1`);
      const filters = encodeURIComponent(JSON.stringify({ label: [`${L}operation-version=1`, `${L}target=${raw.Id}`] }));
      const workers = await this.engine.ok('GET', `/containers/json?all=1&filters=${filters}`);
      for (const worker of workers) {
        const inspected = await this.engine.ok('GET', `/containers/${worker.Id}/json`);
        if (this.labels(inspected)[`${L}target`] !== raw.Id || this.labels(inspected)[`${L}operation-version`] !== '1' || !FULL_ID.test(inspected.Id)) throw new Error('refusing to delete unrelated checkpoint worker');
        await this.engine.ok('DELETE', `/containers/${inspected.Id}?force=1&v=1`);
      }
      // The networking namespace has no saved application state, but belongs to
      // this computer only; remove it last, after all application operations.
      await this.engine.ok('DELETE', `/containers/${anchor.Id}?force=1&v=1`);
      await this.reapOrphans();
      this.needsReap = false;
    });
  }
}
export const dockerCheckpointProvider: ProviderFactory = async (uri, env) => {
  const provider = new DockerCheckpointProvider(uri, env);
  await provider.withLock('startup', async () => {});
  return provider;
};
