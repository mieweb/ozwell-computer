// opensource-server provider (https://github.com/mieweb/opensource-server), REST API v1.
//
//   opensource-server://manager.os.mieweb.org?site=1&domain=2
//     site=<id>          site to create computers in (required)
//     domain=<id>        external domain id for the viewer hostname (required)
//     template=<image>   default ghcr.io/mieweb/ozwell-computer:latest
//     owner=tag|email    tag (default): computers belong to the API key's account and the
//                        Ozwell user is recorded in a tag only. email: also attribute each
//                        computer to the opensource-server user whose mail matches
//                        X-Ozwell-User-Email (the API key must be an admin); fails if none.
//     internal=external|ip  how the orchestrator reaches computers: through the external
//                        https URL (default; works from anywhere) or http://<ipv4>:8080
//                        (when the orchestrator runs on the site's network)
//     tls=0              use http:// for the API (development)
//   API key: OPENSOURCE_SERVER_API_KEY (or the URI's username part).
//
// State is entirely on the containers: environment variables carry the tags and token.
import type { Computer, CreateOptions, Provider, ProviderFactory } from './types.ts';
import { generateId } from './types.ts';

const T = 'OZWELL_ORCHESTRATOR_';
const TAG = {
  managed: `${T}MANAGED`, owner: `${T}OWNER`, ownerEmail: `${T}OWNER_EMAIL`, ownerName: `${T}OWNER_NAME`,
  displayName: `${T}DISPLAY_NAME`, created: `${T}CREATED`,
};
const PORT = 8080;

export class OpensourceServerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

interface OsContainer {
  id: number; hostname: string; owner?: string; status?: string; ipv4Address?: string | null;
  environmentVars?: Record<string, string>; httpEntries?: Array<{ port: number; externalUrl?: string | null }>;
}

export class OpensourceServerProvider implements Provider {
  readonly scheme = 'opensource-server';
  readonly base: string;
  readonly site: number;
  readonly domain: number;
  readonly template: string;
  readonly ownerMode: 'tag' | 'email';
  readonly internal: 'external' | 'ip';
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(uri: URL, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch) {
    const q = uri.searchParams;
    const tls = !['0', 'false', 'no'].includes((q.get('tls') ?? '').toLowerCase());
    this.base = `${tls ? 'https' : 'http'}://${uri.host}/api/v1`;
    this.key = env.OPENSOURCE_SERVER_API_KEY || decodeURIComponent(uri.username);
    if (!this.key) throw new Error('opensource-server provider: set OPENSOURCE_SERVER_API_KEY');
    this.site = Number(q.get('site'));
    this.domain = Number(q.get('domain'));
    if (!Number.isInteger(this.site) || this.site <= 0) throw new Error('opensource-server provider: ?site=<id> is required');
    if (!Number.isInteger(this.domain) || this.domain <= 0) throw new Error('opensource-server provider: ?domain=<external domain id> is required');
    this.template = q.get('template') ?? 'ghcr.io/mieweb/ozwell-computer:latest';
    const owner = q.get('owner') ?? 'tag';
    if (owner !== 'tag' && owner !== 'email') throw new Error('opensource-server provider: owner must be tag or email');
    this.ownerMode = owner;
    const internal = q.get('internal') ?? 'external';
    if (internal !== 'external' && internal !== 'ip') throw new Error('opensource-server provider: internal must be external or ip');
    this.internal = internal;
    this.fetchImpl = fetchImpl;
  }

  private async api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new OpensourceServerError(res.status, json?.error?.code ?? 'error',
        `opensource-server ${method} ${path}: ${json?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return { status: res.status, data: json?.data as T };
  }

  private toComputer(c: OsContainer): Computer {
    const env = c.environmentVars ?? {};
    const external = c.httpEntries?.find((e) => e.port === PORT && e.externalUrl)?.externalUrl ?? undefined;
    const ip = c.ipv4Address ? `http://${c.ipv4Address}:${PORT}` : undefined;
    return {
      id: c.hostname,
      owner: env[TAG.owner] ?? '',
      displayName: env[TAG.displayName] || undefined,
      ownerEmail: env[TAG.ownerEmail] || undefined,
      ownerName: env[TAG.ownerName] || undefined,
      status: c.status ?? 'unknown',
      createdAt: env[TAG.created],
      internalUrl: this.internal === 'ip' ? ip : external,
      externalUrl: external,
      token: env.OZWELL_COMPUTER_TOKEN,
    };
  }

  private managed = (c: OsContainer) => c.environmentVars?.[TAG.managed] === 'true';

  private async find(id: string): Promise<OsContainer | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return null;
    const { data } = await this.api<OsContainer[]>('GET', `/sites/${this.site}/containers?hostname=${encodeURIComponent(id)}`);
    return (data ?? []).find((c) => c.hostname === id && this.managed(c)) ?? null;
  }

  async list(owner: string): Promise<Computer[]> {
    const { data } = await this.api<OsContainer[]>('GET', `/sites/${this.site}/containers`);
    return (data ?? []).filter((c) => this.managed(c) && c.environmentVars?.[TAG.owner] === owner).map((c) => this.toComputer(c));
  }

  async get(id: string): Promise<Computer | null> {
    const c = await this.find(id);
    return c ? this.toComputer(c) : null;
  }

  /** opensource-server username for an Ozwell user, by email (owner=email). */
  private async usernameFor(email: string | undefined): Promise<string> {
    if (!email) throw new Error('owner=email needs the X-Ozwell-User-Email header');
    const { data } = await this.api<Array<{ uid: string; mail?: string; status?: string }>>('GET', '/users');
    const u = (data ?? []).find((x) => x.mail?.toLowerCase() === email.toLowerCase());
    if (!u) throw new Error(`no opensource-server account with email ${email}`);
    return u.uid;
  }

  async create(opts: CreateOptions): Promise<Computer> {
    const hostname = generateId();
    const token = crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    const username = this.ownerMode === 'email' ? await this.usernameFor(opts.owner.email) : undefined;
    const tags: Record<string, string> = {
      [TAG.managed]: 'true',
      [TAG.owner]: opts.owner.id,
      [TAG.ownerEmail]: opts.owner.email ?? '',
      [TAG.ownerName]: opts.owner.name ?? '',
      [TAG.displayName]: opts.displayName ?? '',
      [TAG.created]: new Date().toISOString(),
      OZWELL_COMPUTER_TOKEN: token,
    };
    await this.api('POST', `/sites/${this.site}/containers`, {
      hostname,
      template: this.template,
      ...(username ? { username } : {}),
      environmentVars: Object.entries(tags).map(([key, value]) => ({ key, value })),
      services: {
        // The computer has its own token auth; the site proxy's login would get in the way.
        viewer: { type: 'http', internalPort: PORT, externalHostname: hostname, externalDomainId: this.domain, authRequired: false },
      },
    });
    const c = await this.get(hostname);
    if (!c) throw new Error(`container ${hostname} was not found after creation`);
    return c;
  }

  async destroy(id: string): Promise<void> {
    const c = await this.find(id);
    if (!c) return;
    await this.api('DELETE', `/sites/${this.site}/containers/${c.id}`);
  }
}

export const opensourceServerProvider: ProviderFactory = (uri, env) => new OpensourceServerProvider(uri, env);
