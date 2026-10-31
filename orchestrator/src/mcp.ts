// The orchestrator's MCP server: management tools plus every ozwell-computer tool with an
// added instance_id. Stateless: a fresh MCP server per HTTP request, the requester comes
// from Ozwell's headers on that request, and computers are looked up in the provider.
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Computer, Provider, Requester } from './providers/types.ts';
import { InstanceClient, InstanceError } from './instance-client.ts';
import type { IdleController } from './lifecycle.ts';

export interface ToolDef { name: string; description?: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown } }

export function loadCatalog(path: string | URL): ToolDef[] {
  return JSON.parse(readFileSync(path, 'utf8')).tools;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (reason: string, message: string) => ({ ...text({ error: { reason, message } }), isError: true });

/** What the user/LLM sees about a computer. The token only appears inside the viewer link. */
export function describe(c: Computer) {
  const base = c.externalUrl ?? c.internalUrl;
  return {
    instance_id: c.id,
    display_name: c.displayName ?? null,
    status: c.status,
    stopped: c.stopped,
    ...(c.hibernated === undefined ? {} : { hibernated: c.hibernated }),
    created_at: c.createdAt ?? null,
    viewer_url: base && c.token ? `${base.replace(/\/+$/, '')}/?token=${encodeURIComponent(c.token)}` : base ?? null,
  };
}

const managementTools = (maxInstances: number | undefined, autoRestore = false): ToolDef[] => [
  {
    name: 'list_computers',
    description: 'List your ozwell-computers (virtual Linux desktops) with their current status. Use an instance_id with the other tools. ' +
      (autoRestore ? 'A hibernated computer restores automatically when a desktop tool or viewer connects; other stopped computers require start_computer.' : 'A computer with stopped: true must be started with start_computer first.'),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_computer',
    description: 'Create a new ozwell-computer for you. Waits up to ~40 s for it to start and returns its instance_id and a viewer_url the user can open to watch or take over the screen. If ready is false it is still starting: call get_computer (which also waits) until ready is true.' +
      (maxInstances === undefined ? '' : ` Each user may have at most ${maxInstances} computer(s): prefer reusing an existing one from list_computers.`),
    inputSchema: { type: 'object', properties: { display_name: { type: 'string', description: 'Optional friendly label' } } },
  },
  {
    name: 'get_computer',
    description: 'Status, readiness and viewer_url of one of your computers. If it is still starting, waits up to ~40 s for it. ' +
      (autoRestore ? 'Status inspection leaves hibernated computers asleep; a desktop tool, viewer or start_computer restores them.' : 'If it is stopped, call start_computer.'),
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] },
  },
  {
    name: 'start_computer',
    description: 'Start one of your computers that is stopped (computers may be stopped when idle; nothing on them is lost). Waits up to ~40 s for it like create_computer; if ready is false, call get_computer until ready is true.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] },
  },
  {
    name: 'destroy_computer',
    description: 'Permanently delete one of your computers and everything on it.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] },
  },
];

const hibernationTools: ToolDef[] = [
  {
    name: 'hibernate_computer',
    description: 'Save a quiescent computer to disk and release its VM CPU and RAM, preserving applications and unsaved work. Refuses while viewers, requests, command jobs, upgrades or keep-awake leases are active. The next authorized viewer or desktop tool restores it automatically.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] },
  },
  {
    name: 'keep_computer_awake',
    description: 'Prevent idle hibernation for application work outside Ozwell command jobs, such as a browser download. Restores a hibernated computer and sets or renews its manual keep-awake lease. ttl_ms defaults to one hour, maximum one day. Use allow_computer_hibernation when finished.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' }, ttl_ms: { type: 'integer', minimum: 1, maximum: 86_400_000 } }, required: ['instance_id'] },
  },
  {
    name: 'allow_computer_hibernation',
    description: 'Release the manual keep-awake lease so this computer can hibernate after its idle grace period. Does not close viewers, stop jobs or wake a saved computer.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] },
  },
];

/** Computer tools with an instance_id parameter added. */
export function proxiedTools(catalog: ToolDef[]): ToolDef[] {
  return catalog.map((t) => ({
    ...t,
    description: `${t.description ?? ''} (Runs on the computer given by instance_id; see list_computers / create_computer.)`.trim(),
    inputSchema: {
      ...t.inputSchema,
      properties: { instance_id: { type: 'string', description: 'Which of your computers to use' }, ...(t.inputSchema.properties ?? {}) },
      required: ['instance_id', ...(t.inputSchema.required ?? []).filter((r) => r !== 'instance_id')],
    },
  }));
}

export interface OrchestratorDeps {
  provider: Provider;
  catalog: ToolDef[];
  client: InstanceClient;
  version: string;
  readyTimeoutMs?: number;
  /** Per-user limit on computers; undefined means unlimited. */
  maxInstances?: number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  lifecycle?: IdleController;
}

/** Is the computer up? (Re-reads it: providers may only learn URLs while it starts.) */
export async function isReady(provider: Provider, id: string): Promise<{ c: Computer | null; ready: boolean }> {
  const c = await provider.get(id);
  if (!c?.internalUrl) return { c, ready: false };
  try {
    return { c, ready: (await fetch(`${c.internalUrl}/health`, { signal: AbortSignal.timeout(3000) })).status === 204 };
  } catch {
    return { c, ready: false };
  }
}

/** Wait until ready or the budget runs out (wait, then hand off; see create_computer). While
 * `starting`, a stopped status is expected (the platform hasn't caught up) and not final. */
async function waitReady(provider: Provider, c: Computer, timeoutMs: number, starting = false) {
  const end = Date.now() + timeoutMs;
  let last = { c: c as Computer | null, ready: false };
  for (;;) {
    last = await isReady(provider, c.id);
    // /health can answer before the provider stops reporting the computer as stopped.
    const ready = last.ready && !last.c?.stopped;
    const dead = last.c?.stopped ? !starting : ['failed', 'missing', 'dead'].includes(last.c?.status ?? '');
    if (ready || dead || Date.now() >= end) return { c: last.c ?? c, ready };
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Under common 60 s MCP client request timeouts. */
export const CREATE_WAIT_MS = 40_000;

const stoppedError = (c: Computer) =>
  fail('computer_stopped', `computer ${c.id} is stopped (status: ${c.status}); call start_computer with instance_id "${c.id}", then retry`);

export function buildMcpServer(deps: OrchestratorDeps, user: Requester): Server {
  const { provider, client } = deps;
  const proxied = proxiedTools(deps.catalog);
  const proxiedNames = new Set(proxied.map((t) => t.name));
  const server = new Server({ name: 'ozwell-computer-orchestrator', version: deps.version }, {
    capabilities: { tools: {} },
    instructions:
      'Manages per-user virtual Linux desktops (ozwell-computers). Call list_computers, or create_computer if you have none, ' +
      'then pass its instance_id to the desktop tools (screenshot, click, type_text, ...). Share viewer_url with the user so they can watch. ' +
      (deps.lifecycle ? 'Idle computers hibernate and restore automatically when a desktop tool or viewer connects. Use keep_computer_awake for application work outside command jobs.' : 'Idle computers may be stopped: start them with start_computer.'),
  });

  /** A computer the requester owns, or a not-found error (others' computers are invisible). */
  const mine = async (id: unknown): Promise<Computer> => {
    if (typeof id !== 'string' || !id) throw new InstanceError('invalid_request', 'instance_id is required');
    const c = await provider.get(id);
    if (!c || c.owner !== user.id) throw new InstanceError('target_unavailable', `no computer ${id}; call list_computers`);
    return c;
  };

  /** The quota error when the requester is at the limit, else null. Counted from the provider so it survives restarts. */
  const overQuota = async () => {
    const max = deps.maxInstances;
    if (max === undefined) return null;
    const existing = await provider.list(user.id);
    if (existing.length < max) return null;
    return {
      ...text({
        error: {
          reason: 'quota_exceeded',
          message: `You already have ${existing.length} computer(s); the limit is ${max}. ` +
            'Reuse one of the computers below by its instance_id. Only if the user explicitly agrees, ' +
            'call destroy_computer on one they choose to free up quota, then create_computer again. ' +
            'Never destroy a computer without asking the user first: everything on it is lost.',
        },
        computers: existing.map(describe),
      }),
      isError: true,
    };
  };

  const startWithLifecycle = async (c: Computer, startStopped = false) => {
    try {
      const active = await deps.lifecycle!.acquire(c.id, startStopped);
      try { return text({ ...describe(active.computer), ready: true }); }
      finally { active.release(); }
    } catch (e) {
      // Preserve the management API's wait-then-hand-off contract for cold boots.
      if (e instanceof InstanceError && e.reason === 'computer_starting') {
        return text({ ...describe(await provider.get(c.id) ?? c), ready: false });
      }
      throw e;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...managementTools(deps.maxInstances, !!deps.lifecycle), ...(deps.lifecycle ? hibernationTools : []), ...proxied] }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<any> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    deps.log?.info({ tool: name, user: user.id, instance: args.instance_id }, 'tool call');
    try {
      switch (name) {
        case 'list_computers':
          return text({ computers: (await provider.list(user.id)).map(describe) });
        case 'create_computer': {
          const over = await overQuota();
          if (over) return over;
          const display = typeof args.display_name === 'string' ? args.display_name.slice(0, 64) : undefined;
          const created = await provider.create({ owner: user, displayName: display });
          if (deps.lifecycle) return await startWithLifecycle(created);
          const { c, ready } = await waitReady(provider, created, deps.readyTimeoutMs ?? CREATE_WAIT_MS);
          return text({ ...describe(c), ready });
        }
        case 'get_computer': {
          const c0 = await mine(args.instance_id);
          const { c, ready } = await waitReady(provider, c0, deps.readyTimeoutMs ?? CREATE_WAIT_MS);
          return text({ ...describe(c), ready });
        }
        case 'start_computer': {
          const c0 = await mine(args.instance_id);
          if (deps.lifecycle) return await startWithLifecycle(c0, true);
          // Only stopped ones: a provider's start may restart a running computer.
          const started = c0.stopped ? await provider.start(c0.id) : c0;
          const { c, ready } = await waitReady(provider, started, deps.readyTimeoutMs ?? CREATE_WAIT_MS, c0.stopped);
          return text({ ...describe(c), ready });
        }
        case 'destroy_computer': {
          const c = await mine(args.instance_id);
          await provider.destroy(c.id);
          return text({ ok: true, instance_id: c.id });
        }
        case 'hibernate_computer': {
          if (!deps.lifecycle) return fail('feature_unsupported', 'this provider does not support hibernation');
          const c = await mine(args.instance_id);
          return text(describe(await deps.lifecycle.hibernate(c.id)));
        }
        case 'keep_computer_awake': {
          if (!deps.lifecycle) return fail('feature_unsupported', 'this provider does not support hibernation');
          const c = await mine(args.instance_id);
          const ttl = args.ttl_ms ?? 3_600_000;
          if (typeof ttl !== 'number') return fail('invalid_request', 'ttl_ms must be an integer');
          await deps.lifecycle.keepAwake(c.id, ttl);
          return text({ ok: true, instance_id: c.id, ttl_ms: ttl });
        }
        case 'allow_computer_hibernation': {
          if (!deps.lifecycle) return fail('feature_unsupported', 'this provider does not support hibernation');
          const c = await mine(args.instance_id);
          await deps.lifecycle.allowIdle(c.id);
          return text({ ok: true, instance_id: c.id });
        }
        default: {
          if (!proxiedNames.has(name)) return fail('invalid_request', `unknown tool ${name}`);
          let c = await mine(args.instance_id);
          const active = deps.lifecycle ? await deps.lifecycle.acquire(c.id) : undefined;
          if (active) c = active.computer;
          try {
            if (c.stopped) return stoppedError(c);
            if (!c.internalUrl || !c.token) return fail('target_unavailable', `computer ${c.id} is ${c.status} and not reachable`);
            const { instance_id: _drop, ...rest } = args;
            // The computer shows this as the agent's name, so never the user's.
            const agent = user.agentName ?? 'agent';
            return await client.callTool(`${c.id}\u0000${user.id}\u0000${agent}`, c.internalUrl, c.token, agent, name, rest)
              .catch(async (e) => {
                if (!(e instanceof InstanceError && e.unreachable)) throw e;
                // Best effort: a failed lookup keeps the original error.
                const now = await provider.get(c.id).catch(() => null);
                if (now?.stopped) return stoppedError(now);
                throw e;
              });
          } finally { active?.release(); }
        }
      }
    } catch (e) {
      if (e instanceof InstanceError) return fail(e.reason, e.message);
      deps.log?.warn({ tool: name, err: (e as Error).message }, 'tool failed');
      return fail('internal', (e as Error).message);
    }
  });
  return server;
}
