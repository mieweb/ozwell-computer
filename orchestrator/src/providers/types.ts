// Provider contract. The orchestrator keeps no state of its own: everything about a
// computer (owner, metadata, URLs, token) lives in, and is read back from, the provider.

/** Who is asking, from Ozwell's X-Ozwell-User-* headers. */
export interface Requester {
  /** Opaque, stable user id (X-Ozwell-User-Id). Instances are scoped to it. */
  id: string;
  email?: string;
  name?: string;
  /** The calling agent's name (X-Ozwell-Agent-Name), if Ozwell sends one. */
  agentName?: string;
}

export interface Computer {
  /** Provider-generated, DNS-compatible identifier (the instance_id tools take). */
  id: string;
  /** Opaque owner string; equals Requester.id of the creator. */
  owner: string;
  /** Optional user-friendly label, metadata only. */
  displayName?: string;
  ownerEmail?: string;
  ownerName?: string;
  /** Provider-specific state, e.g. running / exited / creating. */
  status: string;
  /** Stopped (e.g. by the platform when idle) and needs start() before use. */
  stopped: boolean;
  createdAt?: string;
  /** Base URL the orchestrator uses to reach the instance (API + MCP). */
  internalUrl?: string;
  /** Base URL given to the user/LLM for the viewer; defaults to internalUrl. */
  externalUrl?: string;
  /** The instance's access token (orchestrator use, and embedded in viewer links). */
  token?: string;
}

export interface CreateOptions {
  owner: Requester;
  displayName?: string;
}

export interface Provider {
  /** Scheme(s) this provider registered under, for logs. */
  readonly scheme: string;
  /** Computers owned by `owner`. */
  list(owner: string): Promise<Computer[]>;
  /** One computer by id, or null when it doesn't exist (or isn't managed by us). */
  get(id: string): Promise<Computer | null>;
  /** Create and start a computer. May return before it is ready to serve. */
  create(opts: CreateOptions): Promise<Computer>;
  /** Start a stopped computer. May return before it is ready to serve. */
  start(id: string): Promise<Computer>;
  /** Destroy a computer and its storage. */
  destroy(id: string): Promise<void>;
}

/** A provider factory receives the parsed PROVIDER_URI and the environment. */
export type ProviderFactory = (uri: URL, env: NodeJS.ProcessEnv) => Provider | Promise<Provider>;

/** Settings from the orchestrator's environment that every new computer gets. */
export function computerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return env.COMPUTER_FRAME_ANCESTORS ? { OZWELL_COMPUTER_FRAME_ANCESTORS: env.COMPUTER_FRAME_ANCESTORS } : {};
}

/** DNS-label-safe id: prefix plus random lowercase base32 (no repeats needed per provider). */
export function generateId(prefix = 'ozc'): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (const b of bytes) out += alphabet[b & 31];
  return `${prefix}-${out}`;
}
