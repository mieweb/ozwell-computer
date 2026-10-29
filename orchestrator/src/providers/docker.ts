// Reference provider: Docker Engine API (also works against Podman's Docker-compatible socket).
//
//   docker:///var/run/docker.sock                local socket
//   docker://host:2375                           remote daemon (plain TCP)
//
// Query parameters:
//   image=ghcr.io/mieweb/ozwell-computer:latest  image to run
//   network=<name>                               attach to this network (default: daemon default)
//   publish=1                                    publish 8080 on a random host port and use
//                                                http://<publish_host>:<port> as both URLs
//                                                (for an orchestrator outside the Docker network)
//   publish_host=localhost                       host name for published ports
//
// All state is on the containers: labels (owner, metadata) and the token in the env.
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Computer, CreateOptions, Provider, ProviderFactory } from './types.ts';
import { computerEnv, generateId } from './types.ts';

const L = 'org.mieweb.ozwell-computer.';
const LABEL = {
  managed: `${L}managed`, owner: `${L}owner`, displayName: `${L}display-name`,
  ownerEmail: `${L}owner-email`, ownerName: `${L}owner-name`, created: `${L}created`,
};
const PORT = 8080;

interface Target { socketPath?: string; host?: string; port?: number }

export class DockerApi {
  readonly target: Target;
  constructor(target: Target) { this.target = target; }

  call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({
        ...(this.target.socketPath ? { socketPath: this.target.socketPath } : { host: this.target.host, port: this.target.port }),
        method, path,
        headers: { host: 'docker', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: any = text;
          try { data = text ? JSON.parse(text) : null; } catch { /* streamed / plain */ }
          resolve({ status: res.statusCode ?? 0, data });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ok(method: string, path: string, body?: unknown) {
    const r = await this.call(method, path, body);
    if (r.status >= 300) throw new Error(`docker ${method} ${path}: HTTP ${r.status}: ${r.data?.message ?? r.data}`);
    return r.data;
  }
}

export class DockerProvider implements Provider {
  readonly scheme = 'docker';
  readonly api: DockerApi;
  readonly image: string;
  readonly network?: string;
  readonly publish: boolean;
  readonly publishHost: string;
  readonly env: Record<string, string>;

  constructor(uri: URL, env: NodeJS.ProcessEnv = {}) {
    const q = uri.searchParams;
    this.api = new DockerApi(uri.hostname
      ? { host: uri.hostname, port: Number(uri.port || 2375) }
      : { socketPath: decodeURIComponent(uri.pathname) || '/var/run/docker.sock' });
    this.image = q.get('image') ?? 'ghcr.io/mieweb/ozwell-computer:latest';
    this.network = q.get('network') ?? undefined;
    this.publish = ['1', 'true', 'yes'].includes((q.get('publish') ?? '').toLowerCase());
    this.publishHost = q.get('publish_host') ?? (uri.hostname || 'localhost');
    this.env = computerEnv(env);
  }

  private toComputer(c: any): Computer {
    // Accepts both list entries and inspect results.
    const labels = c.Config?.Labels ?? c.Labels ?? {};
    const name = String(c.Name ?? c.Names?.[0] ?? '').replace(/^\//, '');
    const env: string[] = c.Config?.Env ?? [];
    const token = env.find((e) => e.startsWith('OZWELL_COMPUTER_TOKEN='))?.slice('OZWELL_COMPUTER_TOKEN='.length);
    let url: string | undefined;
    if (this.publish) {
      const hostPort = c.NetworkSettings?.Ports?.[`${PORT}/tcp`]?.[0]?.HostPort ?? c.Ports?.find((p: any) => p.PrivatePort === PORT && p.PublicPort)?.PublicPort;
      if (hostPort) url = `http://${this.publishHost}:${hostPort}`;
    } else {
      const nets = c.NetworkSettings?.Networks ?? {};
      const ip = (this.network ? nets[this.network]?.IPAddress : undefined) ?? Object.values<any>(nets).find((n) => n?.IPAddress)?.IPAddress;
      if (ip) url = `http://${ip}:${PORT}`;
    }
    const status: string = c.State?.Status ?? c.State ?? 'unknown';
    return {
      id: name,
      owner: labels[LABEL.owner] ?? '',
      displayName: labels[LABEL.displayName] || undefined,
      ownerEmail: labels[LABEL.ownerEmail] || undefined,
      ownerName: labels[LABEL.ownerName] || undefined,
      status,
      stopped: status === 'exited' || status === 'created',
      createdAt: labels[LABEL.created],
      internalUrl: url,
      externalUrl: url,
      token,
    };
  }

  async list(owner: string): Promise<Computer[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL.managed}=true`, `${LABEL.owner}=${owner}`] }));
    const rows: any[] = await this.api.ok('GET', `/containers/json?all=1&filters=${filters}`);
    // List entries lack env (token) and full network detail: inspect each.
    const out = await Promise.all(rows.map((r) => this.get(r.Id)));
    return out.filter((c): c is Computer => c !== null && c.owner === owner);
  }

  async get(id: string): Promise<Computer | null> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) return null;
    const r = await this.api.call('GET', `/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`docker inspect ${id}: HTTP ${r.status}`);
    if (r.data?.Config?.Labels?.[LABEL.managed] !== 'true') return null;
    return this.toComputer(r.data);
  }

  async create(opts: CreateOptions): Promise<Computer> {
    const id = generateId();
    const token = randomBytes(24).toString('base64url');
    const body = {
      Image: this.image,
      Hostname: id,
      Tty: true,
      Env: Object.entries({ ...this.env, OZWELL_COMPUTER_TOKEN: token }).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [LABEL.managed]: 'true',
        [LABEL.owner]: opts.owner.id,
        [LABEL.displayName]: opts.displayName ?? '',
        [LABEL.ownerEmail]: opts.owner.email ?? '',
        [LABEL.ownerName]: opts.owner.name ?? '',
        [LABEL.created]: new Date().toISOString(),
      },
      ExposedPorts: { [`${PORT}/tcp`]: {} },
      StopSignal: 'SIGRTMIN+3',
      HostConfig: {
        // systemd as PID 1 (same as compose.yml)
        Tmpfs: { '/run': '', '/run/lock': '' },
        Binds: ['/sys/fs/cgroup:/sys/fs/cgroup:rw'],
        CgroupnsMode: 'host',
        ShmSize: 1024 * 1024 * 1024,
        ...(this.network ? { NetworkMode: this.network } : {}),
        ...(this.publish ? { PortBindings: { [`${PORT}/tcp`]: [{ HostPort: '' }] } } : {}),
      },
    };
    const path = `/containers/create?name=${id}`;
    let r = await this.api.call('POST', path, body);
    if (r.status === 404) {
      await this.pull();
      r = await this.api.call('POST', path, body);
    }
    if (r.status >= 300) throw new Error(`docker create: HTTP ${r.status}: ${r.data?.message ?? r.data}`);
    await this.api.ok('POST', `/containers/${id}/start`);
    const c = await this.get(id);
    if (!c) throw new Error(`container ${id} vanished after start`);
    return c;
  }

  async start(id: string): Promise<Computer> {
    const r = await this.api.call('POST', `/containers/${encodeURIComponent(id)}/start`);
    // 304: already running
    if (r.status >= 300 && r.status !== 304) throw new Error(`docker start ${id}: HTTP ${r.status}: ${r.data?.message ?? r.data}`);
    const c = await this.get(id);
    if (!c) throw new Error(`container ${id} vanished after start`);
    return c;
  }

  private async pull() {
    const at = this.image.lastIndexOf(':');
    const [name, tag] = at > this.image.lastIndexOf('/') ? [this.image.slice(0, at), this.image.slice(at + 1)] : [this.image, 'latest'];
    await this.api.ok('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`);
  }

  async destroy(id: string): Promise<void> {
    if (!(await this.get(id))) return;
    await this.api.ok('DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=1`);
  }
}

export const dockerProvider: ProviderFactory = (uri, env) => new DockerProvider(uri, env);
