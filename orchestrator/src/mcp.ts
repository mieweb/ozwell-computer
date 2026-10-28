// The orchestrator's MCP server: management tools plus every ozwell-computer tool with an
// added instance_id. Stateless: a fresh MCP server per HTTP request, the requester comes
// from Ozwell's headers on that request, and computers are looked up in the provider.
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Computer, Provider, Requester } from './providers/types.ts';
import { InstanceClient, InstanceError } from './instance-client.ts';

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
    created_at: c.createdAt ?? null,
    viewer_url: base && c.token ? `${base.replace(/\/+$/, '')}/?token=${encodeURIComponent(c.token)}` : base ?? null,
  };
}

const MANAGEMENT: ToolDef[] = [
  {
    name: 'list_computers',
    description: 'List your ozwell-computers (virtual Linux desktops). Use an instance_id with the other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_computer',
    description: 'Create a new ozwell-computer for you. Waits up to ~40 s for it to start and returns its instance_id and a viewer_url the user can open to watch or take over the screen. If ready is false it is still starting: call get_computer (which also waits) until ready is true.',
    inputSchema: { type: 'object', properties: { display_name: { type: 'string', description: 'Optional friendly label' } } },
  },
  {
    name: 'get_computer',
    description: 'Status, readiness and viewer_url of one of your computers. If it is still starting, waits up to ~40 s for it.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] },
  },
  {
    name: 'destroy_computer',
    description: 'Permanently delete one of your computers and everything on it.',
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
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
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

/** Wait until ready or the budget runs out (wait, then hand off; see create_computer). */
async function waitReady(provider: Provider, c: Computer, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  let last = { c: c as Computer | null, ready: false };
  for (;;) {
    last = await isReady(provider, c.id);
    const dead = ['failed', 'missing', 'exited', 'dead', 'offline'].includes(last.c?.status ?? '');
    if (last.ready || dead || Date.now() >= end) return { c: last.c ?? c, ready: last.ready };
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Under common 60 s MCP client request timeouts. */
export const CREATE_WAIT_MS = 40_000;

export function buildMcpServer(deps: OrchestratorDeps, user: Requester): Server {
  const { provider, client } = deps;
  const proxied = proxiedTools(deps.catalog);
  const proxiedNames = new Set(proxied.map((t) => t.name));
  const server = new Server({ name: 'ozwell-computer-orchestrator', version: deps.version }, {
    capabilities: { tools: {} },
    instructions:
      'Manages per-user virtual Linux desktops (ozwell-computers). Call list_computers, or create_computer if you have none, ' +
      'then pass its instance_id to the desktop tools (screenshot, click, type_text, ...). Share viewer_url with the user so they can watch.',
  });

  /** A computer the requester owns, or a not-found error (others' computers are invisible). */
  const mine = async (id: unknown): Promise<Computer> => {
    if (typeof id !== 'string' || !id) throw new InstanceError('invalid_request', 'instance_id is required');
    const c = await provider.get(id);
    if (!c || c.owner !== user.id) throw new InstanceError('target_unavailable', `no computer ${id}; call list_computers`);
    return c;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...MANAGEMENT, ...proxied] }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<any> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    deps.log?.info({ tool: name, user: user.id, instance: args.instance_id }, 'tool call');
    try {
      switch (name) {
        case 'list_computers':
          return text({ computers: (await provider.list(user.id)).map(describe) });
        case 'create_computer': {
          const display = typeof args.display_name === 'string' ? args.display_name.slice(0, 64) : undefined;
          const created = await provider.create({ owner: user, displayName: display });
          const { c, ready } = await waitReady(provider, created, deps.readyTimeoutMs ?? CREATE_WAIT_MS);
          return text({ ...describe(c), ready });
        }
        case 'get_computer': {
          const c0 = await mine(args.instance_id);
          const { c, ready } = await waitReady(provider, c0, deps.readyTimeoutMs ?? CREATE_WAIT_MS);
          return text({ ...describe(c), ready });
        }
        case 'destroy_computer': {
          const c = await mine(args.instance_id);
          await provider.destroy(c.id);
          return text({ ok: true, instance_id: c.id });
        }
        default: {
          if (!proxiedNames.has(name)) return fail('invalid_request', `unknown tool ${name}`);
          const c = await mine(args.instance_id);
          if (!c.internalUrl || !c.token) return fail('target_unavailable', `computer ${c.id} is ${c.status} and not reachable`);
          const { instance_id: _drop, ...rest } = args;
          return await client.callTool(`${c.id}\u0000${user.id}`, c.internalUrl, c.token, user.name || user.email || user.id, name, rest);
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
