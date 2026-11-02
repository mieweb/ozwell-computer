import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibvirtProvider } from '../src/providers/libvirt.ts';
import { providerFromUri } from '../src/providers/index.ts';
const NS = 'https://mieweb.org/ozwell-computer/libvirt/1';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
interface Domain { xml: string; state: string; saved: boolean }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ozc-libvirt-test-')); roots.push(root);
  const image = join(root, 'image'), storage = join(root, 'storage');
  await mkdir(image); await mkdir(storage);
  for (const name of ['root.qcow2', 'vmlinuz', 'initrd']) await writeFile(join(image, name), 'golden');
  const env = { LIBVIRT_IMAGE_DIR: image, LIBVIRT_STORAGE_DIR: storage, LIBVIRT_SAVE_DIR: root, LIBVIRT_PUBLIC_URL: 'https://{id}.computers.example.test', LIBVIRT_JOB_TIMEOUT_MS: '1000' };
  const domains = new Map<string, Domain>(), calls: Array<{ file: string; args: string[] }> = [];
  const jobs = new Map<string, { types: string | string[] | Error; settled?: () => void }>();
  let now = 0;
  let network = false, saveFailure = false, startFailure = false, defineFailure = false, available = 100 * 1024 ** 3;
  let interruptedSaveJob: string | Error | undefined;
  let activeLocks = 0, maxLocks = 0, lockCalls = 0;
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === 'qemu-img') { if (args[0] === 'info') return JSON.stringify({ 'virtual-size': 1024 ** 3 }); await writeFile(args.at(-1)!, 'cloned-disk'); return ''; }
    if (file === 'genisoimage') { await writeFile(args[args.indexOf('-output') + 1], 'seed'); return ''; }
    if (file !== 'virsh') throw new Error(`unexpected tool ${file}`);
    const a = args.slice(2), cmd = a[0], id = a[1], d = domains.get(id);
    if (cmd === 'list') return [...domains.keys()].join('\n') + '\n';
    if (cmd === 'net-dumpxml') { if (!network) throw new Error('Network not found'); return `<network><metadata><ozwell xmlns="${NS}">network-v1</ozwell></metadata><ip address="192.168.230.1"/></network>`; }
    if (cmd === 'net-define') { network = true; return ''; }
    if (cmd === 'net-info') return 'Active: yes\n';
    if (cmd === 'net-autostart' || cmd === 'net-start') return '';
    if (cmd === 'define') {
      if (defineFailure) throw new Error('cannot define');
      const xml = await readFile(id, 'utf8'), name = xml.match(/<name>([^<]+)<\/name>/)![1], old = domains.get(name);
      domains.set(name, { xml, state: old?.state ?? 'shut off', saved: old?.saved ?? false }); return name;
    }
    if (!d) throw new Error('failed to get domain: Domain not found');
    if (cmd === 'dumpxml') return d.xml;
    if (cmd === 'domjobinfo') {
      const job = jobs.get(id), value = job?.types;
      if (value instanceof Error) throw value;
      const type = Array.isArray(value) ? value.shift() ?? 'None' : value ?? 'None';
      if (type === 'None') job?.settled?.();
      return `Job type: ${type}\n`;
    }
    if (cmd === 'dominfo') return `State: ${d.state}\nManaged save: ${d.saved ? 'yes' : 'no'}\n`;
    if (cmd === 'start') { if (startFailure) throw new Error('incompatible saved CPU'); d.state = 'running'; d.saved = false; return ''; }
    if (cmd === 'managedsave') { if (saveFailure) { if (interruptedSaveJob !== undefined) jobs.set(id, { types: interruptedSaveJob }); throw new Error('disk full or client interrupted'); } d.state = 'shut off'; d.saved = true; return ''; }
    if (cmd === 'destroy') { d.state = 'shut off'; return ''; }
    if (cmd === 'undefine') { domains.delete(id); return ''; }
    throw new Error(`unexpected virsh ${a.join(' ')}`);
  };
  const deps = { run, freeBytes: async () => available, now: () => now, sleep: async (ms: number) => { now += ms; },
    lock: async <T>(_path: string, fn: () => Promise<T>) => { lockCalls++; activeLocks++; maxLocks = Math.max(maxLocks, activeLocks); try { return await fn(); } finally { activeLocks--; } } };
  const p = new LibvirtProvider(new URL('libvirt:///system'), env, deps);
  return { p, env, deps, domains, calls, root, storage,
    job: (id: string, types: string | string[] | Error, settled?: () => void) => jobs.set(id, { types, settled }),
    interruptSave: (job: string | Error) => { saveFailure = true; interruptedSaveJob = job; },
    failure: (operation: 'save' | 'start' | 'define', enabled = true) => { if (operation === 'save') saveFailure = enabled; else if (operation === 'start') startFailure = enabled; else defineFailure = enabled; },
    space: (n: number) => { available = n; }, locks: () => ({ maxLocks, lockCalls }),
  };
}
describe('libvirt provider', () => {
  it('registers explicit local URIs and validates public hostname and private network', async () => {
    const f = await fixture(); expect((await providerFromUri('libvirt:///system', f.env)).scheme).toBe('libvirt');
    expect(() => new LibvirtProvider(new URL('libvirt://remote/system'), f.env)).toThrow(/local/);
    expect(() => new LibvirtProvider(new URL('libvirt:///system'), { ...f.env, LIBVIRT_PUBLIC_URL: 'https://computers.test' })).toThrow(/hostname label/);
    expect(() => new LibvirtProvider(new URL('libvirt:///system'), { ...f.env, LIBVIRT_SUBNET: '8.8.8' })).toThrow(/private IPv4/);
    expect(() => new LibvirtProvider(new URL('libvirt:///system'), { ...f.env, LIBVIRT_MEMORY_MIB: 'NaN' })).toThrow(/integer/);
  });
  it('creates independent disks and durable ownership without credentials in argv', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice', name: '<Alice>' }, displayName: 'Desktop & work' });
    expect(c).toMatchObject({ owner: 'alice', ownerName: '<Alice>', displayName: 'Desktop & work', status: 'running', stopped: false, hibernated: false,
      internalUrl: 'http://192.168.230.2:8080', externalUrl: `https://${c.id}.computers.example.test` });
    expect(c.token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(f.domains.get(c.id)!.xml).toContain('host-passthrough');
    expect(await readFile(join(f.storage, c.id, 'root.qcow2'), 'utf8')).toBe('cloned-disk');
    expect((await stat(join(f.storage, c.id, 'seed.iso'))).mode & 0o777).toBe(0o600);
    expect(f.calls.every(({ args }) => !args.some((a) => a.includes(c.token!) || a.includes(Buffer.from(c.token!).toString('base64'))))).toBe(true);
    const restarted = new LibvirtProvider(new URL('libvirt:///system'), f.env, f.deps);
    expect(await restarted.get(c.id)).toEqual(c); expect(await restarted.list('bob')).toEqual([]); expect(await restarted.list('alice')).toEqual([c]);
    expect((await restarted.create({ owner: { id: 'bob' } })).internalUrl).toBe('http://192.168.230.3:8080');
  });
  it('uses the shared wake gateway setting for new computers', async () => {
    const f = await fixture();
    const p = new LibvirtProvider(new URL('libvirt:///system'), { ...f.env, COMPUTER_GATEWAY_URL: 'https://{id}.shared.example.test' }, f.deps);
    const c = await p.create({ owner: { id: 'alice' } });
    expect(p.publicUrl).toBe('https://{id}.shared.example.test');
    expect(c.externalUrl).toBe(`https://${c.id}.shared.example.test`);
  });
  it('uses an SSE4.2 capable guest CPU for explicit emulation', async () => {
    const f = await fixture(), p = new LibvirtProvider(new URL('libvirt:///system'), { ...f.env, LIBVIRT_DOMAIN_TYPE: 'qemu' }, f.deps);
    const c = await p.create({ owner: { id: 'alice' } }); expect(f.domains.get(c.id)!.xml).toContain('Nehalem');
  });
  it('rediscovers managed save after controller restart and restores once for concurrent wakes', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } });
    expect(await f.p.hibernate(c.id)).toMatchObject({ status: 'hibernated', stopped: true, hibernated: true, token: c.token });
    expect(f.calls.find(({ args }) => args.includes('managedsave'))?.args.slice(-3)).toEqual(['managedsave', c.id, '--running']);
    const p = new LibvirtProvider(new URL('libvirt:///system'), f.env, f.deps);
    expect(await p.listAll()).toEqual([expect.objectContaining({ id: c.id, hibernated: true })]);
    const before = f.calls.filter(({ args }) => args.includes('start')).length;
    const [a, b] = await Promise.all([p.start(c.id), p.start(c.id)]); expect(a).toEqual(b); expect(a.hibernated).toBe(false);
    expect(f.calls.filter(({ args }) => args.includes('start')).length - before).toBe(1);
  });
  it('preserves saved RAM after restore errors and never cold boots as fallback', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); await f.p.hibernate(c.id); f.failure('start');
    await expect(f.p.start(c.id)).rejects.toThrow(/incompatible saved CPU/); expect(await f.p.get(c.id)).toMatchObject({ hibernated: true, stopped: true });
    expect(f.domains.get(c.id)!.saved).toBe(true); expect(f.calls.some(({ args }) => args.includes('managedsave-remove') || args.includes('--force-boot'))).toBe(false);
    f.failure('start', false); expect((await f.p.start(c.id)).hibernated).toBe(false);
  });
  it('blocks cold boot if an externally removed save image had a durable save intent', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); await f.p.hibernate(c.id); f.domains.get(c.id)!.saved = false;
    const before = f.calls.filter(({ args }) => args.includes('start')).length;
    await expect(f.p.start(c.id)).rejects.toThrow(/refusing cold boot/); expect(f.calls.filter(({ args }) => args.includes('start')).length).toBe(before);
    expect((await f.p.get(c.id))!.hibernated).toBe(true);
  });
  it('preserves the running guest on low save space and failed save', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.space(0);
    await expect(f.p.hibernate(c.id)).rejects.toThrow(/insufficient free space/); expect(f.calls.some(({ args }) => args.includes('managedsave'))).toBe(false);
    f.space(100 * 1024 ** 3); f.failure('save'); await expect(f.p.hibernate(c.id)).rejects.toThrow(/disk full/);
    expect(await f.p.get(c.id)).toMatchObject({ status: 'running', hibernated: false }); expect(f.domains.has(c.id)).toBe(true);
  });
  it('retains domain and disk for recovery when the initial start fails', async () => {
    const f = await fixture(); f.failure('start'); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/incompatible/);
    const [id] = f.domains.keys(); expect((await stat(join(f.storage, id, 'root.qcow2'))).isFile()).toBe(true);
    expect(await f.p.listAll()).toEqual([expect.objectContaining({ id, owner: 'alice', stopped: true })]);
  });
  it('cleans undefined partial creation when definition fails', async () => {
    const f = await fixture(); f.failure('define'); await expect(f.p.create({ owner: { id: 'alice' } })).rejects.toThrow(/cannot define/);
    await expect(stat(f.calls.find(({ args }) => args.includes('convert'))!.args.at(-1)!)).rejects.toThrow(/ENOENT/);
  });
  it('serializes the entire reentrant lifecycle callback', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), events: string[] = [];
    await Promise.all([f.p.withLock(c.id, async () => { events.push('one'); await f.p.hibernate(c.id); events.push('saved'); }),
      f.p.withLock(c.id, async () => { events.push('two'); await f.p.start(c.id); events.push('running'); })]);
    expect(events).toEqual(['one', 'saved', 'two', 'running']); expect(f.locks()).toEqual({ maxLocks: 1, lockCalls: 3 });
  });
  it('waits for a surviving daemon save job before a restarted controller can reopen admission', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } });
    await f.p.hibernate(c.id);
    const d = f.domains.get(c.id)!; d.state = 'running'; d.saved = false;
    const before = f.calls.length;
    f.job(c.id, ['Bounded', 'Bounded', 'None'], () => { d.state = 'shut off'; d.saved = true; });
    const restarted = new LibvirtProvider(new URL('libvirt:///system'), f.env, f.deps);
    let admitted = false;
    await restarted.withLock(c.id, async () => {
      admitted = true;
      expect(await restarted.get(c.id)).toMatchObject({ stopped: true, hibernated: true });
      expect(f.calls.slice(before).filter(({ args }) => args.includes('domjobinfo'))).toHaveLength(3);
    });
    expect(admitted).toBe(true);
  });
  it('fails admission closed on continuing, unqueryable or malformed daemon jobs', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); await f.p.hibernate(c.id);
    const d = f.domains.get(c.id)!; d.state = 'running'; d.saved = false;
    const restarted = new LibvirtProvider(new URL('libvirt:///system'), f.env, f.deps);
    let admitted = false;
    f.job(c.id, 'Bounded');
    await expect(restarted.withLock(c.id, async () => { admitted = true; })).rejects.toThrow(/still Bounded/);
    expect(admitted).toBe(false); expect((await restarted.get(c.id))!.hibernated).toBe(true);
    f.job(c.id, new Error('libvirt connection lost'));
    await expect(restarted.withLock(c.id, async () => { admitted = true; })).rejects.toThrow(/cannot verify lifecycle job/);
    f.job(c.id, '');
    await expect(restarted.withLock(c.id, async () => { admitted = true; })).rejects.toThrow(/missing job type/);
    expect(admitted).toBe(false); expect((await restarted.get(c.id))!.hibernated).toBe(true);
  });
  it('also guards reentrant admission when the outer lock was acquired for another operation', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.job(c.id, 'Unbounded');
    let admitted = false;
    await expect(f.p.withLock('create', () => f.p.withLock(c.id, async () => { admitted = true; }))).rejects.toThrow(/still Unbounded/);
    expect(admitted).toBe(false);
  });
  it.each(['Bounded', new Error('cannot reach libvirt')])('keeps save intent when interrupted managedsave cannot settle (%s)', async (job) => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }); f.interruptSave(job);
    await expect(f.p.hibernate(c.id)).rejects.toThrow(/closed admission/);
    expect(await f.p.get(c.id)).toMatchObject({ status: 'running', hibernated: true });
    let admitted = false;
    await expect(f.p.withLock(c.id, async () => { admitted = true; })).rejects.toThrow(/closed admission/);
    expect(admitted).toBe(false);
    expect(f.calls.some(({ args }) => args.includes('managedsave-remove') || args.includes('--force-boot'))).toBe(false);
  });
  it('accepts an inactive domjobinfo exception only after confirming shut-off state', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } });
    f.job(c.id, new Error('Requested operation is not valid: domain is not running'));
    await expect(f.p.withLock(c.id, async () => {})).rejects.toThrow(/cannot verify lifecycle job/);
    f.domains.get(c.id)!.state = 'shut off';
    await expect(f.p.withLock(c.id, async () => 'confirmed inactive')).resolves.toBe('confirmed inactive');
  });
  it('deletes only explicitly managed domains and their owned storage', async () => {
    const f = await fixture(), c = await f.p.create({ owner: { id: 'alice' } }), other = 'ozc-aaaaaaaaaa';
    f.domains.set(other, { xml: '<domain><name>ozc-aaaaaaaaaa</name></domain>', saved: false, state: 'running' });
    expect(await f.p.get(other)).toBeNull(); expect(await f.p.get('../../etc')).toBeNull(); await f.p.destroy(other); expect(f.domains.has(other)).toBe(true);
    await f.p.hibernate(c.id); await f.p.destroy(c.id); expect(f.domains.has(c.id)).toBe(false); await expect(stat(join(f.storage, c.id))).rejects.toThrow(/ENOENT/);
    expect(f.calls.find(({ args }) => args.includes('undefine'))!.args).toContain('--managed-save');
  });
});
