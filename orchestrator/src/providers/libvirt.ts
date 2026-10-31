// Local libvirt backend. Domain metadata and persistent disks are the source of
// truth; a restarted controller can discover and resume every managed computer.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, statfs, stat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computerEnv, generateId, type Computer, type CreateOptions, type Provider, type ProviderFactory } from './types.ts';

const exec = promisify(execFile);
const NS = 'https://mieweb.org/ozwell-computer/libvirt/1';
const metadataPattern = () => new RegExp(`<(?:(?:[\\w-]+):)?ozwell\\b[^>]*\\bxmlns(?::[\\w-]+)?=["']${NS.replaceAll('.', '\\.')}["'][^>]*>([A-Za-z0-9+/=]+)</(?:(?:[\\w-]+):)?ozwell>`);
const ID = /^ozc-[a-z2-7]{10}$/;
const GiB = 1024 ** 3;
export interface LibvirtDependencies {
  run?: (file: string, args: string[]) => Promise<string>;
  lock?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
  freeBytes?: (path: string) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
interface Metadata {
  version: 1; id: string; uuid: string; owner: string; displayName?: string;
  ownerEmail?: string; ownerName?: string; createdAt: string; token: string;
  address: string; mac: string; externalUrl: string; memoryMiB: number;
  /** Persisted before save; prevents a failed restore from silently cold booting. */
  saved?: boolean;
}
const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
const integer = (value: string | undefined, fallback: number, name: string, min = 1, max = 1048576) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
};

/** Keep a kernel flock held while the JS callback runs. No command is shell parsed. */
async function flock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const child = spawn('flock', ['--exclusive', '--timeout', '120', path, process.execPath, '-e', 'process.stdout.write("locked\\n"); process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`libvirt lifecycle lock failed (${code}): ${stderr}`)));
  });
  // Attach rejection handler immediately, even while waiting for the ready line.
  void exited.catch(() => {});
  await Promise.race([new Promise<void>((ready) => child.stdout.once('data', () => ready())), exited.then(() => { throw new Error('libvirt lifecycle lock exited before acquisition'); })]);
  try { return await fn(); } finally { child.stdin.end(); await exited; }
}

export class LibvirtProvider implements Provider {
  readonly scheme = 'libvirt';
  readonly connection: string;
  readonly storage: string;
  readonly image: string;
  readonly saveDir: string;
  readonly network: string;
  readonly subnet: string;
  readonly publicUrl: string;
  readonly domainType: 'kvm' | 'qemu';
  readonly memoryMiB: number;
  readonly vcpus: number;
  readonly jobTimeoutMs: number;
  private readonly env: Record<string, string>;
  private readonly run: NonNullable<LibvirtDependencies['run']>;
  private readonly hostLock: NonNullable<LibvirtDependencies['lock']>;
  private readonly freeBytes: NonNullable<LibvirtDependencies['freeBytes']>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly context = new AsyncLocalStorage<boolean>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(uri: URL, env: NodeJS.ProcessEnv = process.env, deps: LibvirtDependencies = {}) {
    if (uri.hostname || uri.pathname !== '/system' || uri.search || uri.hash) throw new Error('libvirt URI must be libvirt:///system (local host only)');
    this.connection = `qemu://${uri.pathname}`;
    this.storage = resolve(env.LIBVIRT_STORAGE_DIR ?? '/var/lib/ozwell-computer');
    if (!env.LIBVIRT_IMAGE_DIR) throw new Error('LIBVIRT_IMAGE_DIR must contain root.qcow2, vmlinuz and initrd');
    this.image = resolve(env.LIBVIRT_IMAGE_DIR);
    this.saveDir = resolve(env.LIBVIRT_SAVE_DIR ?? '/var/lib/libvirt/qemu/save');
    this.network = env.LIBVIRT_NETWORK ?? 'ozwell-computer';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(this.network)) throw new Error('invalid LIBVIRT_NETWORK');
    this.subnet = env.LIBVIRT_SUBNET ?? '192.168.230';
    if (!/^(10\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3})$/.test(this.subnet) || this.subnet.split('.').some((n) => +n > 255)) throw new Error('LIBVIRT_SUBNET must be three private IPv4 octets');
    this.publicUrl = env.LIBVIRT_PUBLIC_URL ?? '';
    let external: URL;
    try { external = new URL(this.publicUrl.replace('{id}', 'ozc-test')); } catch { throw new Error('LIBVIRT_PUBLIC_URL must be e.g. https://{id}.computers.example.com'); }
    if (this.publicUrl.split('{id}').length !== 2 || !/^https?:\/\/\{id\}\./i.test(this.publicUrl) || !external.hostname.startsWith('ozc-test.') || !['http:', 'https:'].includes(external.protocol) || external.username || external.password || external.search || external.hash || !['', '/'].includes(external.pathname)) throw new Error('LIBVIRT_PUBLIC_URL requires one {id} hostname label and no path or credentials');
    this.domainType = (env.LIBVIRT_DOMAIN_TYPE ?? 'kvm') as 'kvm' | 'qemu';
    if (!['kvm', 'qemu'].includes(this.domainType)) throw new Error('LIBVIRT_DOMAIN_TYPE must be kvm or qemu');
    this.memoryMiB = integer(env.LIBVIRT_MEMORY_MIB, 2048, 'LIBVIRT_MEMORY_MIB', 512);
    this.vcpus = integer(env.LIBVIRT_VCPUS, 2, 'LIBVIRT_VCPUS', 1, 256);
    this.jobTimeoutMs = integer(env.LIBVIRT_JOB_TIMEOUT_MS, 120_000, 'LIBVIRT_JOB_TIMEOUT_MS', 1, 300_000);
    this.env = computerEnv(env);
    this.run = deps.run ?? (async (file, args) => (await exec(file, args, { timeout: file === 'virsh' && args[2] === 'domjobinfo' ? Math.min(this.jobTimeoutMs, 10_000) : 300_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout);
    this.hostLock = deps.lock ?? flock;
    this.freeBytes = deps.freeBytes ?? (async (path) => { const s = await statfs(path); return s.bavail * s.bsize; });
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private virsh(...args: string[]) { return this.run('virsh', ['--connect', this.connection, ...args]); }
  private dir(id: string) { if (!ID.test(id)) throw new Error('invalid computer id'); return join(this.storage, id); }
  private metadataXml(m: Metadata) { return `<ozwell xmlns="${NS}">${Buffer.from(JSON.stringify(m)).toString('base64')}</ozwell>`; }
  private async readMetadata(id: string): Promise<Metadata | null> {
    if (!ID.test(id)) return null;
    let xml: string;
    try { xml = await this.virsh('dumpxml', id, '--inactive'); }
    catch (e) { if (/failed to get domain|Domain not found|no domain with matching/i.test(String(e))) return null; throw e; }
    const match = xml.match(metadataPattern());
    if (!match) return null;
    let m: Metadata;
    try { m = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')); } catch { throw new Error(`invalid managed metadata for ${id}`); }
    if (m.version !== 1 || m.id !== id || !m.owner || !m.token || !/^[a-f0-9-]{36}$/.test(m.uuid) || !Number.isSafeInteger(m.memoryMiB) || m.memoryMiB < 512 || !new RegExp(`^${this.subnet.replaceAll('.', '\\.')}\\.(?:[2-9]|[1-9]\\d|1\\d\\d|2[0-4]\\d|25[0-4])$`).test(m.address)) throw new Error(`invalid managed metadata for ${id}`);
    const uuid = xml.match(/<uuid>([^<]+)<\/uuid>/)?.[1];
    if (uuid !== m.uuid) throw new Error(`managed metadata UUID mismatch for ${id}`);
    return m;
  }
  private async writeMetadata(m: Metadata) {
    const xml = await this.virsh('dumpxml', m.id, '--inactive');
    if (!metadataPattern().test(xml)) throw new Error(`managed metadata disappeared for ${m.id}`);
    const path = join(this.dir(m.id), 'domain.xml');
    // Never put the token (even base64 encoded) in a command argument.
    await writeFile(path, xml.replace(metadataPattern(), this.metadataXml(m)), { mode: 0o600 });
    await this.virsh('define', path);
  }
  private async state(id: string) {
    const info = await this.virsh('dominfo', id);
    const state = info.match(/^State:\s+(.+)$/m)?.[1].trim() ?? 'unknown';
    const saved = /^Managed save:\s+yes\s*$/m.test(info);
    return { state, saved };
  }
  private async computer(m: Metadata): Promise<Computer> {
    const s = await this.state(m.id);
    // The durable intent survives a failed restore or externally removed image.
    const hibernated = s.saved || !!m.saved;
    return { id: m.id, owner: m.owner, displayName: m.displayName, ownerEmail: m.ownerEmail, ownerName: m.ownerName, createdAt: m.createdAt,
      token: m.token, internalUrl: `http://${m.address}:8080`, externalUrl: m.externalUrl,
      status: s.state === 'shut off' && hibernated ? 'hibernated' : s.state.replaceAll(' ', '-'), stopped: s.state === 'shut off', hibernated };
  }
  async get(id: string): Promise<Computer | null> { const m = await this.readMetadata(id); return m ? this.computer(m) : null; }
  async listAll(): Promise<Computer[]> {
    const names = (await this.virsh('list', '--all', '--name')).split(/\r?\n/).filter((id) => ID.test(id));
    const rows = await Promise.all(names.map((id) => this.get(id)));
    return rows.filter((c): c is Computer => c !== null);
  }
  async list(owner: string): Promise<Computer[]> { return (await this.listAll()).filter((c) => c.owner === owner); }

  /** The daemon can outlive a killed/timed-out virsh/controller. A released flock
   * alone therefore cannot prove that a save/restore transaction has finished. */
  private async waitForJob(id: string): Promise<void> {
    const deadline = this.now() + this.jobTimeoutMs;
    for (;;) {
      let info: string;
      try { info = await this.virsh('domjobinfo', id); }
      catch (error) {
        // Some libvirt versions reject domjobinfo on inactive guests. Require an
        // independently confirmed inactive state; every other query error closes
        // admission and leaves durable save intent untouched.
        if (/domain is not running|domain is not active/i.test(String(error)) && (await this.state(id)).state === 'shut off') return;
        throw new Error(`cannot verify lifecycle job for ${id}; retaining state and closed admission`, { cause: error });
      }
      const type = info.match(/^Job type:[ \t]*(.*)$/m)?.[1].trim();
      if (!type) throw new Error(`cannot verify lifecycle job for ${id}: missing job type`);
      if (type.toLowerCase() === 'none') return;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new Error(`lifecycle job for ${id} is still ${type}; retaining state and closed admission`);
      await this.sleep(Math.min(250, remaining));
    }
  }
  private async guardJob(id: string) { if (ID.test(id) && await this.readMetadata(id)) await this.waitForJob(id); }

  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) { await this.guardJob(id); return fn(); }
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => { release = r; });
    await previous.catch(() => {});
    try {
      await mkdir(this.storage, { recursive: true, mode: 0o711 });
      return await this.hostLock(join(this.storage, '.lifecycle.lock'), () => this.context.run(true, async () => { await this.guardJob(id); return fn(); }));
    } finally { release(); }
  }
  private async requireMetadata(id: string) { const m = await this.readMetadata(id); if (!m) throw new Error(`computer ${id} not found`); return m; }
  private async requireSpace(path: string, bytes: number) {
    if (await this.freeBytes(path) < bytes) throw new Error(`insufficient free space in ${path}; need ${Math.ceil(bytes / GiB)} GiB`);
  }
  private async ensureNetwork() {
    let xml: string;
    try { xml = await this.virsh('net-dumpxml', this.network); }
    catch (e) {
      if (!/failed to get network|Network not found|no network with matching/i.test(String(e))) throw e;
      const dir = await mkdtemp(join(tmpdir(), 'ozc-network-'));
      try {
        const path = join(dir, 'network.xml');
        await writeFile(path, `<network><name>${escapeXml(this.network)}</name><metadata><ozwell xmlns="${NS}">network-v1</ozwell></metadata><forward mode="nat"/><bridge stp="on" delay="0"/><port isolated="yes"/><ip address="${this.subnet}.1" netmask="255.255.255.0"/></network>`, { mode: 0o600 });
        await this.virsh('net-define', path);
      } finally { await rm(dir, { recursive: true, force: true }); }
      xml = await this.virsh('net-dumpxml', this.network);
    }
    if (!xml.includes(NS) || !xml.includes('network-v1') || !xml.includes(`address="${this.subnet}.1"`) && !xml.includes(`address='${this.subnet}.1'`)) throw new Error(`refusing unmanaged or incompatible network ${this.network}`);
    const info = await this.virsh('net-info', this.network);
    if (!/^Active:\s+yes\s*$/m.test(info)) await this.virsh('net-start', this.network);
    await this.virsh('net-autostart', this.network);
  }
  private domainXml(m: Metadata) {
    const attr = escapeXml;
    return `<domain type="${this.domainType}"><name>${m.id}</name><uuid>${m.uuid}</uuid><metadata>${this.metadataXml(m)}</metadata>
<memory unit="MiB">${m.memoryMiB}</memory><vcpu>${this.vcpus}</vcpu>
${this.domainType === 'kvm' ? '<cpu mode="host-passthrough" migratable="off"/>' : '<cpu mode="custom" match="exact"><model fallback="forbid">Nehalem</model></cpu>'}
<os><type arch="x86_64" machine="pc">hvm</type><kernel>${attr(join(this.image, 'vmlinuz'))}</kernel><initrd>${attr(join(this.image, 'initrd'))}</initrd><cmdline>root=/dev/vda rw console=ttyS0</cmdline></os>
<on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>preserve</on_crash><devices>
<disk type="file" device="disk"><driver name="qemu" type="qcow2"/><source file="${attr(join(this.dir(m.id), 'root.qcow2'))}"/><target dev="vda" bus="virtio"/></disk>
<disk type="file" device="cdrom"><driver name="qemu" type="raw"/><source file="${attr(join(this.dir(m.id), 'seed.iso'))}"/><target dev="sda" bus="sata"/><readonly/></disk>
<interface type="network"><mac address="${m.mac}"/><source network="${attr(this.network)}"/><model type="virtio"/><port isolated="yes"/><filterref filter="clean-traffic"><parameter name="IP" value="${m.address}"/></filterref></interface>
<serial type="pty"><target type="isa-serial" port="0"/></serial><console type="pty"><target type="serial" port="0"/></console><memballoon model="none"/>
</devices></domain>`;
  }
  async create(opts: CreateOptions): Promise<Computer> {
    return this.withLock('create', async () => {
      if (!opts.owner.id) throw new Error('owner id is required');
      await ensureFiles(this.image, ['root.qcow2', 'vmlinuz', 'initrd']);
      await this.ensureNetwork();
      const computers = await this.listAll();
      const used = new Set(computers.map((c) => new URL(c.internalUrl!).hostname));
      let address = '';
      for (let n = 2; n <= 254; n++) if (!used.has(`${this.subnet}.${n}`)) { address = `${this.subnet}.${n}`; break; }
      if (!address) throw new Error('libvirt network has no free addresses');
      const imageInfo = JSON.parse(await this.run('qemu-img', ['info', '--output=json', join(this.image, 'root.qcow2')]));
      if (!Number.isSafeInteger(imageInfo['virtual-size']) || imageInfo['virtual-size'] < 1) throw new Error('invalid golden image virtual size');
      await this.requireSpace(this.storage, imageInfo['virtual-size'] + GiB);
      const id = generateId();
      const m: Metadata = { version: 1, id, uuid: randomUUID(), owner: opts.owner.id, displayName: opts.displayName, ownerEmail: opts.owner.email, ownerName: opts.owner.name, createdAt: new Date().toISOString(), token: randomBytes(32).toString('base64url'), address,
        mac: `52:54:00:${[...randomBytes(3)].map((b) => b.toString(16).padStart(2, '0')).join(':')}`, externalUrl: this.publicUrl.replace('{id}', id).replace(/\/$/, ''), memoryMiB: this.memoryMiB };
      const dir = this.dir(id);
      await mkdir(dir, { mode: 0o711 });
      const seed = await mkdtemp(join(tmpdir(), 'ozc-seed-'));
      let defined = false;
      try {
        await this.run('qemu-img', ['convert', '-f', 'qcow2', '-O', 'qcow2', join(this.image, 'root.qcow2'), join(dir, 'root.qcow2')]);
        await chmod(join(dir, 'root.qcow2'), 0o600);
        const guestEnv = { ...this.env, OZWELL_COMPUTER_TOKEN: m.token, OZWELL_COMPUTER_HOST: '0.0.0.0', OZWELL_COMPUTER_UPDATE_URL: 'off' };
        // systemd EnvironmentFile syntax. Newlines/quotes must never inject settings.
        const envText = Object.entries(guestEnv).map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '').replaceAll('\r', '')}"`).join('\n') + '\n';
        await writeFile(join(seed, 'ozwell.env'), envText, { mode: 0o600 });
        await writeFile(join(seed, 'ozwell.network'), `[Match]\nMACAddress=${m.mac}\n[Network]\nAddress=${m.address}/24\nGateway=${this.subnet}.1\nDNS=${this.subnet}.1\n`, { mode: 0o600 });
        await this.run('genisoimage', ['-quiet', '-output', join(dir, 'seed.iso'), '-volid', 'OZC_CONFIG', '-joliet', '-rock', seed]);
        await chmod(join(dir, 'seed.iso'), 0o600);
        const xmlPath = join(dir, 'domain.xml');
        await writeFile(xmlPath, this.domainXml(m), { mode: 0o600 });
        await this.virsh('define', xmlPath); defined = true;
        await this.virsh('start', id);
        return this.computer(m);
      } catch (error) {
        // Once defined, keep the disk+domain for recovery; never erase a failed VM.
        if (!defined) await rm(dir, { recursive: true, force: true });
        throw error;
      } finally { await rm(seed, { recursive: true, force: true }); }
    });
  }
  async start(id: string): Promise<Computer> {
    return this.withLock(id, async () => {
      const m = await this.requireMetadata(id);
      const s = await this.state(id);
      if (s.state === 'running') { if (m.saved && !s.saved) { delete m.saved; await this.writeMetadata(m); } return this.computer(m); }
      if (s.state !== 'shut off') throw new Error(`cannot resume ${id} from ${s.state}`);
      if (m.saved && !s.saved) throw new Error(`saved state missing for ${id}; refusing cold boot`);
      // No --force-boot, managedsave-remove or fallback: failed restore preserves RAM.
      await this.virsh('start', id);
      const after = await this.state(id);
      if (after.state !== 'running' || after.saved) throw new Error(`restore of ${id} did not reach running state`);
      if (m.saved) { delete m.saved; await this.writeMetadata(m); }
      return this.computer(m);
    });
  }
  async hibernate(id: string): Promise<Computer> {
    return this.withLock(id, async () => {
      const m = await this.requireMetadata(id);
      const s = await this.state(id);
      if (s.saved && s.state === 'shut off') return this.computer(m);
      if (s.state !== 'running' || s.saved) throw new Error(`cannot hibernate ${id} from ${s.state}`);
      // RAM may be incompressible. Leave both a 10% margin and one GiB reserve.
      await this.requireSpace(this.saveDir, Math.ceil(m.memoryMiB * 1024 ** 2 * 1.1) + GiB);
      m.saved = true; await this.writeMetadata(m);
      try { await this.virsh('managedsave', id, '--running'); }
      catch (error) {
        // An interrupted client does not abort the daemon's save job. Never clear
        // intent while that job is active or its state cannot be established.
        await this.waitForJob(id);
        const after = await this.state(id);
        if (after.state === 'running' && !after.saved) { delete m.saved; await this.writeMetadata(m); }
        throw error;
      }
      const after = await this.state(id);
      if (after.state !== 'shut off' || !after.saved) throw new Error(`managed save of ${id} did not complete; state preserved for recovery`);
      return this.computer(m);
    });
  }
  async destroy(id: string): Promise<void> {
    return this.withLock(id, async () => {
      const m = await this.readMetadata(id); if (!m) return;
      const s = await this.state(id);
      if (s.state !== 'shut off') await this.virsh('destroy', id);
      // Explicit user deletion is the only path allowed to remove managed RAM.
      await this.virsh('undefine', id, '--managed-save');
      await rm(this.dir(id), { recursive: true, force: true });
    });
  }
}
async function ensureFiles(dir: string, files: string[]) { for (const name of files) { const s = await stat(join(dir, name)); if (!s.isFile()) throw new Error(`${join(dir, name)} must be a file`); } }
export const libvirtProvider: ProviderFactory = (uri, env) => new LibvirtProvider(uri, env);
