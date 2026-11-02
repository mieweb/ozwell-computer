import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DockerApi, DockerProvider } from '../src/providers/docker.ts';
import { DockerCheckpointProvider } from '../src/providers/docker-checkpoint.ts';
import { CheckpointLock } from '../src/providers/checkpoint-lock.ts';
const L = 'org.mieweb.ozwell-computer.';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
type Outcome = 0 | 1 | 2 | 64 | 'running';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ozc-checkpoint-')); roots.push(root);
  const env = { DOCKER_CHECKPOINT_PUBLIC_URL: 'http://{id}.computers.test:8090', DOCKER_CHECKPOINT_LOCK_DIR: root, DOCKER_CHECKPOINT_JOB_TIMEOUT_MS: '1000' };
  const all = new Map<string, any>(), checkpoints = new Map<string, Set<string>>(), calls: Array<{ method: string; path: string; body?: any }> = [];
  let sequence = 0, now = 0, saveOutcome: Outcome = 0, restoreOutcome: Outcome = 0;
  let mainCreateFailure = 0, mainStartFailure = 0, missingNetworkImage = false;
  let imageArchitecture = 'arm64', engineArchitecture = 'aarch64', profile = 'flat-v1';
  let failedDelete = '';
  const find = (id: string) => all.get(id) ?? [...all.values()].find((r) => r.Name === `/${id}` || r.Config.Labels?.[`${L}instance-id`] === id && r.Config.Labels?.[`${L}checkpoint-version`] === '1');
  const complete = (worker: any, outcome: Outcome) => {
    worker.State = { Status: outcome === 'running' ? 'running' : 'exited', Pid: outcome === 'running' ? 123 : 0, ExitCode: outcome === 'running' ? 0 : outcome, OOMKilled: false };
    const l = worker.Config.Labels, target = all.get(l[`${L}target`]), cp = `ozc-${l[`${L}generation`]}`;
    if (outcome !== 0) return;
    if (l[`${L}operation`] === 'save') { target.State = { Status: 'exited', Pid: 0 }; checkpoints.get(target.Id)!.add(cp); target.NetworkSettings.Ports = {}; }
    else { target.State = { Status: 'running', Pid: 45 }; target.NetworkSettings.Ports = { '8080/tcp': [{ HostPort: String(42000 + sequence) }] }; }
  };
  const api = new DockerApi({});
  api.call = async (method, path, body?: any) => {
    calls.push({ method, path, body });
    const u = new URL(`http://docker${path}`), parts = u.pathname.split('/').filter(Boolean);
    if (method === 'GET' && parts[0] === 'info') return { status: 200, data: { OSType: 'linux', Architecture: engineArchitecture } };
    if (method === 'GET' && parts[0] === 'images') return { status: missingNetworkImage && decodeURIComponent(parts[1]).startsWith('alpine:') ? 404 : 200, data: { Id: `sha256:${'a'.repeat(64)}`, Os: 'linux', Architecture: imageArchitecture, Config: { Labels: { [`${L}checkpoint-profile`]: profile } } } };
    if (method === 'GET' && u.pathname === '/containers/json') {
      const filters = JSON.parse(u.searchParams.get('filters') ?? '{}');
      return { status: 200, data: [...all.values()].filter((r) => (filters.label ?? []).every((label: string) => { const at = label.indexOf('='); return r.Config.Labels?.[label.slice(0, at)] === label.slice(at + 1); })).map((r) => ({ Id: r.Id })) };
    }
    if (method === 'POST' && u.pathname === '/containers/create') {
      if (body?.Labels?.[`${L}checkpoint-version`] === '1' && mainCreateFailure) return { status: mainCreateFailure, data: {} };
      const name = u.searchParams.get('name')!; if ([...all.values()].some((r) => r.Name === `/${name}`)) return { status: 409, data: {} };
      const id = (++sequence).toString(16).padStart(64, '0');
      all.set(id, { Id: id, Name: `/${name}`, Config: body, HostConfig: body.HostConfig, State: { Status: 'created', Pid: 0 }, NetworkSettings: { Ports: {}, Networks: { default: { IPAddress: '192.0.2.2' } } } }); checkpoints.set(id, new Set());
      return { status: 201, data: { Id: id } };
    }
    // Engine direct lookup accepts names and unique ID prefixes, not stable labels.
    const prefixes = [...all.values()].filter((r) => r.Id.startsWith(parts[1]));
    const raw = all.get(parts[1]) ?? [...all.values()].find((r) => r.Name === `/${parts[1]}`) ?? (prefixes.length === 1 ? prefixes[0] : undefined);
    if (!raw) return { status: 404, data: {} };
    if (method === 'GET' && parts[2] === 'json') return { status: 200, data: structuredClone(raw) };
    if (method === 'GET' && parts[2] === 'checkpoints') return { status: 200, data: [...checkpoints.get(raw.Id)!].map((Name) => ({ Name })) };
    if (method === 'POST' && parts[2] === 'rename') { raw.Name = `/${u.searchParams.get('name')}`; return { status: 204, data: null }; }
    if (method === 'POST' && parts[2] === 'start') {
      if (raw.Config.Labels?.[`${L}checkpoint-version`] === '1' && mainStartFailure) return { status: mainStartFailure, data: {} };
      if (raw.Config.Labels?.[`${L}operation-version`] === '1') complete(raw, raw.Config.Labels[`${L}operation`] === 'save' ? saveOutcome : restoreOutcome);
      else { raw.State = { Status: 'running', Pid: 42 }; raw.NetworkSettings = raw.HostConfig?.NetworkMode?.startsWith('container:') ? { Ports: {}, Networks: {} } : { Ports: { '8080/tcp': [{ HostPort: '41000' }] }, Networks: { default: { IPAddress: '192.0.2.2' } } }; }
      return { status: 204, data: null };
    }
    if (method === 'DELETE' && parts[2] === 'checkpoints') { checkpoints.get(raw.Id)!.delete(parts[3]); return { status: 204, data: null }; }
    if (method === 'DELETE' && parts.length === 2) { if (failedDelete === raw.Id) { failedDelete = ''; return { status: 500, data: {} }; } all.delete(raw.Id); return { status: 204, data: null }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const deps = { api, lock: async <T>(fn: () => Promise<T>) => fn(), now: () => now, sleep: async (ms: number) => { now += ms; }, guestPrepared: async () => true };
  const make = () => new DockerCheckpointProvider(new URL('docker-checkpoint:///var/run/docker.sock?publish=1'), env, deps);
  return { p: make(), make, env, deps, all, checkpoints, calls, find, complete,
    createFailure: (status: number) => { mainCreateFailure = status; }, startFailure: (status: number) => { mainStartFailure = status; }, missingImage: () => { missingNetworkImage = true; },
    source: (architecture: string, nextProfile = 'flat-v1', engine = 'aarch64') => { imageArchitecture = architecture; profile = nextProfile; engineArchitecture = engine; },
    failDeleteOnce: (id: string) => { failedDelete = id; },
    outcome: (operation: 'save' | 'restore', value: Outcome) => { if (operation === 'save') saveOutcome = value; else restoreOutcome = value; },
    workers: () => [...all.values()].filter((r) => r.Config.Labels?.[`${L}operation-version`] === '1'),
  };
}
describe('opt-in Docker checkpoint provider', () => {
  it('requires local engine/wildcard gateway and leaves ordinary Docker unchanged', async () => {
    const f = await fixture(); expect(() => new DockerCheckpointProvider(new URL('docker-checkpoint://remote:2375'), f.env)).toThrow(/local Docker/);
    expect(() => new DockerCheckpointProvider(new URL('docker-checkpoint:///sock'), { ...f.env, DOCKER_CHECKPOINT_PUBLIC_URL: 'http://computers.test' })).toThrow(/gateway URL/);
    expect(new DockerCheckpointProvider(new URL('docker-checkpoint:///sock'), { ...f.env, COMPUTER_GATEWAY_URL: 'https://{id}.example.test' }).publicUrl).toBe('https://{id}.example.test');
    expect((new DockerProvider(new URL('docker:///sock')) as any).hibernate).toBeUndefined();
  });
  it('creates terminal-free opt-in computers with stable public identity and routing', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' }, displayName: 'My desktop' }), raw = f.find(c.id);
    expect(raw.Config.Tty).toBe(false); expect(raw.HostConfig).toMatchObject({ AutoRemove: false, RestartPolicy: { Name: 'no' } }); expect(raw.Config.Env).toContain('UV_USE_IO_URING=0');
    expect(raw.Config.Image).toBe(`sha256:${'a'.repeat(64)}`); expect(raw.HostConfig.Binds).toBeUndefined(); expect(raw.HostConfig.CgroupnsMode).toBeUndefined(); expect(raw.HostConfig.SecurityOpt).toBeUndefined(); expect(raw.Config.StopSignal).toBe('SIGTERM');
    expect(raw.HostConfig.Annotations).toEqual({ 'org.criu.config': '/opt/ozc-criu/ozwell.conf' });
    expect(c).toMatchObject({ owner: 'alice', displayName: 'My desktop', hibernated: false, externalUrl: `http://${c.id}.computers.test:8090`, internalUrl: 'http://localhost:41000' });
    expect(await f.p.list('bob')).toEqual([]); expect(await f.p.listAll()).toEqual([c]);
    const anchor = f.all.get(raw.Config.Labels[`${L}network-anchor`]);
    expect(raw.HostConfig.NetworkMode).toBe(`container:${anchor.Id}`);
    expect(raw.Config.Hostname).toBeUndefined(); expect(raw.Config.ExposedPorts).toBeUndefined(); expect(raw.HostConfig.PortBindings).toBeUndefined();
    expect(anchor.Config).toMatchObject({ Image: 'alpine:3.19', Tty: false, Entrypoint: ['/bin/sleep'], Cmd: ['infinity'] });
    expect(anchor.HostConfig).toMatchObject({ RestartPolicy: { Name: 'unless-stopped' }, ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: 'default' });
  });
  it('saves/restores repeatedly without leaking receipt containers or changing public URLs', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), original = f.find(c.id).Id;
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await f.p.hibernate(c.id)).toMatchObject({ id: c.id, externalUrl: c.externalUrl, status: 'hibernated', hibernated: true, stopped: true, internalUrl: c.internalUrl });
      expect(f.find(original).Name).toMatch(/--saved-/); expect((await f.make().get(c.id))!.token).toBe(c.token); expect(f.workers()).toHaveLength(0);
      const restored = await f.p.start(c.id); expect(restored).toMatchObject({ id: c.id, externalUrl: c.externalUrl, hibernated: false, stopped: false });
      expect(restored.internalUrl).toBe(c.internalUrl); expect(f.find(c.id).Id).toBe(original); expect(f.checkpoints.get(original)!.size).toBe(0); expect(f.workers()).toHaveLength(0);
    }
    const creates = f.calls.filter((r) => r.body?.Labels?.[`${L}operation-version`]); expect(creates).toHaveLength(4);
    expect(creates[0].body.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, RestartPolicy: { Name: 'no' }, CapDrop: ['ALL'] });
  });
  it('retains state after completed restore failure and retries only the checkpoint worker', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), id = f.find(c.id).Id; await f.p.hibernate(c.id); f.outcome('restore', 64); const before = f.calls.length;
    await expect(f.p.start(c.id)).rejects.toThrow(/saved state retained/); expect(await f.p.get(c.id)).toMatchObject({ stopped: true, hibernated: true }); expect(f.checkpoints.get(id)!.size).toBe(1);
    expect(f.calls.slice(before).some((r) => r.method === 'POST' && r.path === `/containers/${id}/start`)).toBe(false);
    f.outcome('restore', 0); expect((await f.make().start(c.id)).hibernated).toBe(false);
  });
  it('refuses cold boot when a saved checkpoint is externally removed', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), id = f.find(c.id).Id; await f.p.hibernate(c.id); f.checkpoints.get(id)!.clear(); const before = f.calls.length;
    await expect(f.p.start(c.id)).rejects.toThrow(/refusing cold boot/); expect(f.calls.slice(before).some((r) => r.method === 'POST' && r.path.endsWith('/start'))).toBe(false);
  });
  it('recovers durable save intent after controller death before worker creation/start', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.find(c.id).Name = `/${c.id}--saving-0123456789abcdef`;
    await f.make().withLock(c.id, async () => { expect(await f.p.get(c.id)).toMatchObject({ stopped: true, hibernated: true }); }); expect(f.workers()).toHaveLength(0);
  });
  it('will not begin a recovered save after guest admission was reopened', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.find(c.id).Name = `/${c.id}--saving-0123456789abcdef`;
    const p = new DockerCheckpointProvider(new URL('docker-checkpoint:///sock?publish=1'), f.env, { ...f.deps, guestPrepared: async () => false });
    await expect(p.withLock(c.id, async () => {})).rejects.toThrow(/no longer prepared/);
    expect(f.workers()[0].State.Status).toBe('created');
  });
  it('authenticates the fresh guest gate and requires explicit idle fields before worker start', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id);
    const status = { prepared: true, busy: true, active_requests: 0, connections: 0, running_jobs: 0, leases: 0 };
    const headers: Array<{ auth?: string; connection?: string }> = [];
    const guest = createServer((req, res) => { headers.push({ auth: req.headers.authorization, connection: req.headers.connection }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status)); });
    await new Promise<void>((resolve) => guest.listen(0, '127.0.0.1', resolve));
    try {
      f.all.get(raw.Config.Labels[`${L}network-anchor`]).NetworkSettings.Ports['8080/tcp'][0].HostPort = String((guest.address() as any).port);
      raw.Name = `/${c.id}--saving-0123456789abcdef`;
      const p = new DockerCheckpointProvider(new URL('docker-checkpoint:///sock?publish=1'), f.env, { ...f.deps, guestPrepared: undefined });
      await expect(p.withLock(c.id, async () => {})).rejects.toThrow(/no longer prepared/);
      status.busy = false; status.active_requests = 1;
      await expect(p.withLock(c.id, async () => {})).rejects.toThrow(/no longer prepared/);
      status.active_requests = 0;
      await p.withLock(c.id, async () => {});
      expect(headers).toEqual(Array.from({ length: 3 }, () => ({ auth: `Bearer ${c.token}`, connection: 'close' })));
      expect(await p.get(c.id)).toMatchObject({ hibernated: true, stopped: true });
    } finally { guest.closeAllConnections(); await new Promise<void>((resolve) => guest.close(() => resolve())); }
  });
  it('never mistakes an in-progress checkpoint directory for daemon completion', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), id = f.find(c.id).Id; f.outcome('save', 'running'); await expect(f.p.hibernate(c.id)).rejects.toThrow(/still running/);
    const worker = f.workers()[0]; f.checkpoints.get(id)!.add(`ozc-${worker.Config.Labels[`${L}generation`]}`); let admitted = false;
    await expect(f.make().withLock(c.id, async () => { admitted = true; })).rejects.toThrow(/still running/); expect(admitted).toBe(false);
    f.complete(worker, 0); await f.make().withLock(c.id, async () => { expect(await f.p.get(c.id)).toMatchObject({ stopped: true, hibernated: true }); });
  });
  it.each([1, 2])('keeps admission closed after ambiguous worker exit %s', async (exit) => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.outcome('save', exit as Outcome); await expect(f.p.hibernate(c.id)).rejects.toThrow(/ambiguous/);
    let admitted = false; await expect(f.make().withLock(c.id, async () => { admitted = true; })).rejects.toThrow(/ambiguous/); expect(admitted).toBe(false); expect((await f.p.get(c.id))!.hibernated).toBe(true);
  });
  it('reopens only after a confirmed HTTP save failure leaves the target running', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.outcome('save', 64); await expect(f.p.hibernate(c.id)).rejects.toThrow(/running workload retained/);
    expect(await f.p.get(c.id)).toMatchObject({ hibernated: false, stopped: false }); expect(f.workers()).toHaveLength(0);
  });
  it('serializes concurrent wakes and guards nested callbacks', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); await f.p.hibernate(c.id); const [a, b] = await Promise.all([f.p.start(c.id), f.p.start(c.id)]); expect(a).toEqual(b);
    expect(f.calls.filter((r) => r.body?.Labels?.[`${L}operation`] === 'restore')).toHaveLength(1);
    f.outcome('save', 'running'); await expect(f.p.hibernate(c.id)).rejects.toThrow(/still running/); await expect(f.p.withLock('create', () => f.p.withLock(c.id, async () => {}))).rejects.toThrow(/still running/);
  });
  it('rejects corrupted identities, unsafe profiles and worker executable mismatches', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id); raw.Config.Tty = true;
    await expect(f.p.start(c.id)).rejects.toThrow(/unsafe terminal/); raw.Config.Tty = false; raw.Name = `/${c.id}--unknown`; await expect(f.p.get(c.id)).rejects.toThrow(/invalid checkpoint transaction/); raw.Name = `/${c.id}`;
    f.outcome('save', 'running'); await expect(f.p.hibernate(c.id)).rejects.toThrow(/still running/); f.workers()[0].Config.Cmd = ['wrong'];
    await expect(f.p.withLock(c.id, async () => {})).rejects.toThrow(/identity\/configuration mismatch/);
  });
  it('allows explicit deletion of an ambiguous owned transaction and retains other computers', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), other = await f.p.create({ owner: { id: 'bob' } }); f.outcome('save', 2);
    await expect(f.p.hibernate(c.id)).rejects.toThrow(/ambiguous/); await f.p.destroy(c.id); expect(await f.p.get(c.id)).toBeNull(); expect(await f.p.get(other.id)).not.toBeNull(); expect(f.workers()).toHaveLength(0);
    expect(f.all.size).toBe(2); // The unrelated application and its namespace anchor.
  });
  it('retries orphan cleanup after deletion fails between main and worker removal', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), other = await f.p.create({ owner: { id: 'bob' } });
    f.outcome('save', 2); await expect(f.p.hibernate(c.id)).rejects.toThrow(/ambiguous/); f.failDeleteOnce(f.workers()[0].Id);
    await expect(f.p.destroy(c.id)).rejects.toThrow(/HTTP 500/); expect(await f.p.get(c.id)).toBeNull(); expect(f.workers()).toHaveLength(1);
    await f.make().destroy(c.id); expect(f.workers()).toHaveLength(0); expect(f.all.size).toBe(2); expect(await f.p.get(other.id)).not.toBeNull();
  });
  it('reaps an orphan anchor at startup while preserving running and saved namespace references', async () => {
    const f = await fixture(), gone = await f.p.create({ owner: { id: 'gone' } }), running = await f.p.create({ owner: { id: 'running' } }), saved = await f.p.create({ owner: { id: 'saved' } });
    const orphan = f.find(gone.id), anchorId = orphan.Config.Labels[`${L}network-anchor`];
    await f.p.hibernate(saved.id); f.all.delete(orphan.Id);
    await f.make().withLock('startup', async () => {});
    expect(f.all.has(anchorId)).toBe(false); expect(await f.p.get(running.id)).toMatchObject({ stopped: false }); expect(await f.p.get(saved.id)).toMatchObject({ stopped: true, hibernated: true });
    expect(f.all.size).toBe(4);
  });
  it('preserves an orphan anchor referenced by an unrelated container using its short ID', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id);
    const oldId = raw.Config.Labels[`${L}network-anchor`], anchor = f.all.get(oldId);
    f.all.delete(raw.Id); f.all.delete(oldId); anchor.Id = 'a'.repeat(64); f.all.set(anchor.Id, anchor);
    const shortId = anchor.Id.slice(0, 12), foreignId = 'f'.repeat(64);
    f.all.set(foreignId, { Id: foreignId, Name: '/unrelated', Config: { Labels: {} }, HostConfig: { NetworkMode: `container:${shortId}` } });
    await f.make().withLock('startup', async () => {});
    expect(f.calls.some((r) => r.method === 'GET' && r.path === `/containers/${shortId}/json`)).toBe(true);
    expect(f.all.has(anchor.Id)).toBe(true); expect(f.all.has(foreignId)).toBe(true);
    expect(f.calls.some((r) => r.method === 'DELETE')).toBe(false);
  });
  it('retains all orphan anchors when a foreign namespace target no longer resolves', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id), anchorId = raw.Config.Labels[`${L}network-anchor`];
    f.all.delete(raw.Id);
    const foreignId = 'f'.repeat(64);
    f.all.set(foreignId, { Id: foreignId, Name: '/unrelated', Config: { Labels: {} }, HostConfig: { NetworkMode: 'container:gone-target' } });
    await f.make().withLock('startup', async () => {});
    expect(f.all.has(anchorId)).toBe(true); expect(f.all.has(foreignId)).toBe(true);
    expect(f.calls.some((r) => r.method === 'DELETE')).toBe(false);
  });
  it('restarts an owned namespace anchor before restoring the application', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id), anchor = f.all.get(raw.Config.Labels[`${L}network-anchor`]);
    await f.p.hibernate(c.id); anchor.State = { Status: 'exited', Pid: 0 }; anchor.NetworkSettings = { Ports: {}, Networks: {} };
    const before = f.calls.length; const restored = await f.make().start(c.id);
    const calls = f.calls.slice(before), anchorStart = calls.findIndex((r) => r.path === `/containers/${anchor.Id}/start`), restoreCreate = calls.findIndex((r) => r.body?.Labels?.[`${L}operation`] === 'restore');
    expect(anchorStart).toBeGreaterThanOrEqual(0); expect(restoreCreate).toBeGreaterThan(anchorStart);
    expect(restored).toMatchObject({ stopped: false, hibernated: false, internalUrl: c.internalUrl });
  });
  it('refuses an anchor belonging to another computer or owner before any deletion', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id), anchor = f.all.get(raw.Config.Labels[`${L}network-anchor`]);
    anchor.Config.Labels[`${L}owner`] = 'bob'; const before = f.calls.length;
    await expect(f.p.get(c.id)).rejects.toThrow(/anchor ownership/); await expect(f.p.destroy(c.id)).rejects.toThrow(/anchor ownership/);
    expect(f.calls.slice(before).some((r) => r.method === 'DELETE')).toBe(false); expect(f.all.has(raw.Id)).toBe(true);
  });
  it('retains existing anchor identity when the image for future computers changes', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } });
    const updated = new DockerCheckpointProvider(new URL('docker-checkpoint:///sock?publish=1'), { ...f.env, DOCKER_CHECKPOINT_NETWORK_IMAGE: 'alpine:future' }, f.deps);
    expect(await updated.get(c.id)).toMatchObject({ id: c.id, owner: 'alice', internalUrl: c.internalUrl });
  });
  it('pins each computer CRIU annotation while allowing future configuration changes', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } });
    expect(() => new DockerCheckpointProvider(new URL('docker-checkpoint:///sock'), { ...f.env, DOCKER_CHECKPOINT_CRIU_CONFIG: 'relative.conf' }, f.deps)).toThrow(/absolute daemon-host path/);
    const updated = new DockerCheckpointProvider(new URL('docker-checkpoint:///sock?publish=1'), { ...f.env, DOCKER_CHECKPOINT_CRIU_CONFIG: '/future/criu.conf' }, f.deps);
    expect(await updated.get(c.id)).toMatchObject({ id: c.id });
    f.find(c.id).HostConfig.Annotations['org.criu.config'] = '/different/criu.conf';
    await expect(updated.start(c.id)).rejects.toThrow(/annotation mismatch/);
  });
  it('cleans a known empty anchor on application creation failure but retains defined applications', async () => {
    const f = await fixture(); f.createFailure(404); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/pre-pull/); expect(f.all.size).toBe(0);
    f.createFailure(0); f.startFailure(500); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/HTTP 500/); expect(f.all.size).toBe(2);
    expect(await f.p.list('alice')).toEqual([expect.objectContaining({ stopped: true })]);
  });
  it('rejects an unavailable anchor image before creating any resources', async () => {
    const f = await fixture(); f.missingImage(); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/network image/); expect(f.all.size).toBe(0);
  });
  it('rejects emulated or ordinary systemd images before allocating a network anchor', async () => {
    const f = await fixture(); f.source('amd64'); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/native architecture/); expect(f.all.size).toBe(0);
    f.source('arm64', 'ordinary-systemd'); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/profile flat-v1/); expect(f.all.size).toBe(0);
    f.source('amd64', 'flat-v1', 'x86_64'); expect(await f.p.create({ owner: { id: 'alice' } })).toMatchObject({ owner: 'alice' });
  });
  it('prevents an ordinary Docker controller from exposing or cold-starting checkpoint computers', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), id = f.find(c.id).Id;
    await f.p.hibernate(c.id);
    const legacy = new DockerProvider(new URL('docker:///sock')); legacy.api.call = f.deps.api.call;
    expect(await legacy.get(id)).toBeNull(); expect(await legacy.list('alice')).toEqual([]);
    const before = f.calls.length; await expect(legacy.start(id)).rejects.toThrow(/not found/);
    expect(f.calls.slice(before).some((r) => r.method === 'POST' && r.path.endsWith('/start'))).toBe(false);
  });
  it('uses the immutable instance label when another container claims the freed baseline name', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), id = f.find(c.id).Id;
    await f.p.hibernate(c.id);
    f.all.set('e'.repeat(64), { Id: 'e'.repeat(64), Name: `/${c.id}`, Config: { Labels: {} } });
    expect(await f.make().get(c.id)).toMatchObject({ id: c.id, owner: 'alice', stopped: true, hibernated: true });
    expect(f.find(id).Name).toMatch(/--saved-/);
  });
  it('collects a successful restore receipt after a crash following phase promotion', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), raw = f.find(c.id);
    await f.p.hibernate(c.id); await f.p.start(c.id);
    const created = f.calls.find((r) => r.body?.Labels?.[`${L}operation`] === 'restore')!;
    const config = structuredClone(created.body), generation = config.Labels[`${L}generation`], id = 'f'.repeat(64);
    f.all.set(id, { Id: id, Name: `/${new URL(`http://docker${created.path}`).searchParams.get('name')}`, Config: config, HostConfig: config.HostConfig, State: { Status: 'exited', Pid: 0, ExitCode: 0 } });
    f.checkpoints.get(raw.Id)!.add(`ozc-${generation}`);
    await f.make().withLock(c.id, async () => {});
    expect(f.workers()).toHaveLength(0); expect(f.checkpoints.get(raw.Id)!.size).toBe(0);
  });
});
describe('checkpoint coordinator OS lock', () => {
  it('serializes independent SQLite connections without expiring a live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ozc-sqlite-lock-')); roots.push(root); const a = new CheckpointLock(root), b = new CheckpointLock(root), events: string[] = [];
    let release!: () => void, ready!: () => void; const began = new Promise<void>((r) => { ready = r; }), gate = new Promise<void>((r) => { release = r; });
    const first = a.run(async () => { events.push('first'); ready(); await gate; events.push('released'); }); await began;
    const second = b.run(async () => { events.push('second'); }); await new Promise((r) => setTimeout(r, 80)); expect(events).toEqual(['first']); release();
    await Promise.all([first, second]); expect(events).toEqual(['first', 'released', 'second']);
  });
  it('releases the OS lock after a separate coordinator process is killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ozc-sqlite-crash-')); roots.push(root);
    const moduleUrl = new URL('../src/providers/checkpoint-lock.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { CheckpointLock } = await import(${JSON.stringify(moduleUrl)}); await new CheckpointLock(${JSON.stringify(root)}).run(async () => { process.stdout.write('locked\\n'); await new Promise(() => setInterval(() => {}, 1000)); });`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout, 'data'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await expect(new CheckpointLock(root).run(async () => 'recovered')).resolves.toBe('recovered');
  });
});
