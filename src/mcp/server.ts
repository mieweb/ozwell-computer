import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AppContext } from '../server.js';
import { ApiError, toApiError } from '../errors.js';
import type { Principal } from '../presence/index.js';
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, jobsFor, present } from '../process/jobs.js';
import { safePath } from '../fs/index.js';
import { launchDetached } from '../routes/windows.js';
import { m } from '../metrics.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean; [k: string]: unknown }

const text = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

async function wrap(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    const err = toApiError(e);
    const hint: Record<string, string> = {
      stale_geometry: 'Take a new screenshot and use its screenshot_id.',
      stale_snapshot: 'Call get_ui_tree or find_element again.',
      stale_handle: 'Call list_windows again.',
    };
    return { content: [{ type: 'text', text: JSON.stringify({ ...err.toBody(), ...(hint[err.reason] ? { hint: hint[err.reason] } : {}) }) }], isError: true };
  }
}

const Coord = {
  x: z.number().describe('X coordinate'),
  y: z.number().describe('Y coordinate'),
  screenshot_id: z.string().optional().describe('Interpret x/y in the pixel space of this screenshot (recommended)'),
  space: z.enum(['screen', 'window', 'screenshot', 'normalized']).optional(),
  window: z.string().optional().describe('Window id for space=window|normalized'),
};
const Mods = z.array(z.string()).optional().describe('Modifiers held during the action: ctrl, shift, alt, super');

function buildMcp(ctx: AppContext, principal: () => Principal): McpServer {
  const { desktop, config } = ctx;
  const mcp = new McpServer({ name: 'ozwell-computer', version: ctx.version }, {
    instructions:
      'Controls a Linux X11 desktop. Typical loop: screenshot → act using coordinates from that screenshot (pass its screenshot_id) → screenshot to verify. ' +
      'Prefer find_element/ui_action for apps that expose accessibility. Errors carry a "reason"; on stale_geometry take a new screenshot.',
  });

  // Log every tool call by name (operational visibility; also used by the test-coverage check).
  const register = mcp.registerTool.bind(mcp) as (...a: any[]) => unknown;
  (mcp as any).registerTool = (name: string, config: unknown, cb: (...a: any[]) => Promise<ToolResult>) =>
    register(name, config, async (...a: any[]) => {
      const p = principal();
      ctx.log.info({ tool: name, agent: p.name, session: p.id }, 'mcp tool call');
      const r = await cb(...a);
      m.mcpToolCalls.inc({ tool: name, outcome: r.isError ? 'error' : 'ok' });
      return r;
    });

  mcp.registerTool('screenshot', {
    description: 'Capture the screen (or one window). Returns an image plus screenshot_id; pass that id with coordinates taken from this image. ' +
      'Set ocr to also get the text in the image as an extra text item.',
    inputSchema: {
      window: z.string().optional(), max_dimension: z.number().int().min(64).max(4096).optional().describe('Default 1280'),
      format: z.enum(['png', 'jpeg', 'webp']).optional(), cursor: z.boolean().optional(),
      ocr: z.boolean().optional().describe('Also return text extracted from the screenshot (OCR via tesseract)'),
    },
  }, async (a) => wrap(async () => {
    const r = await desktop.screenshot({ window: a.window, max_dimension: a.max_dimension ?? 1280, format: a.format ?? 'png', cursor: a.cursor ?? true, quality: 75, ocr: a.ocr });
    const e = r.entry;
    const content: Content[] = [
      { type: 'image', data: r.data.toString('base64'), mimeType: r.contentType },
      { type: 'text', text: JSON.stringify({ screenshot_id: e.id, width: e.imageSize.width, height: e.imageSize.height, native_width: e.nativeSize.width, native_height: e.nativeSize.height, scale: e.scale }) },
    ];
    return { content: r.text !== undefined ? [...content, { type: 'text', text: r.text }] : content };
  }));

  const pointer = (req: any) => wrap(async () => text(await desktop.pointerAction(req, principal())));

  mcp.registerTool('click', {
    description: 'Click at a point.',
    inputSchema: { ...Coord, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional(), modifiers: Mods },
  }, async (a) => pointer({ action: 'click', ...a }));

  mcp.registerTool('double_click', { description: 'Double-click at a point.', inputSchema: { ...Coord, modifiers: Mods } },
    async (a) => pointer({ action: 'click', count: 2, ...a }));

  mcp.registerTool('move', { description: 'Move the pointer.', inputSchema: { ...Coord } }, async (a) => pointer({ action: 'move', ...a }));

  mcp.registerTool('drag', {
    description: 'Press at (x,y), drag to (to_x,to_y), release. Both points use the same coordinate space.',
    inputSchema: { ...Coord, to_x: z.number(), to_y: z.number(), button: z.enum(['left', 'right', 'middle']).optional(), modifiers: Mods, duration_ms: z.number().int().min(0).max(5000).optional() },
  }, async (a) => pointer({ action: 'drag', ...a, to: { x: a.to_x, y: a.to_y } }));

  mcp.registerTool('scroll', {
    description: 'Scroll the wheel at a point. dy>0 scrolls down, dx>0 scrolls right; units are wheel clicks.',
    inputSchema: { ...Coord, dx: z.number().optional(), dy: z.number().optional(), modifiers: Mods },
  }, async (a) => pointer({ action: 'scroll', ...a }));

  const kb = (req: any) => wrap(async () => text(await desktop.keyboardAction(req, principal())));
  mcp.registerTool('type_text', {
    description: 'Type text into the focused window. mode=paste uses the clipboard (more robust for long or non-ASCII text).',
    inputSchema: { text: z.string(), mode: z.enum(['keystrokes', 'paste']).optional() },
  }, async (a) => kb({ action: 'type', ...a }));
  mcp.registerTool('press_key', {
    description: 'Press a key (e.g. Enter, Escape, Tab, ArrowDown, F5, a) optionally with modifiers.',
    inputSchema: { key: z.string(), modifiers: Mods, repeat: z.number().int().min(1).max(50).optional() },
  }, async (a) => kb({ action: 'press', ...a }));
  mcp.registerTool('hotkey', {
    description: 'Press a key combination, e.g. ["ctrl","shift","t"] or ["alt","F4"].',
    inputSchema: { keys: z.array(z.string()).min(1).max(6) },
  }, async (a) => kb({ action: 'hotkey', keys: a.keys }));

  mcp.registerTool('list_windows', { description: 'List top-level windows with ids, titles, bounds and focus.', inputSchema: {} },
    async () => wrap(async () => text({ windows: await desktop.ctl().windows.list() })));
  mcp.registerTool('activate_window', { description: 'Raise and focus a window.', inputSchema: { window: z.string() } },
    async (a) => wrap(async () => {
      const wm = desktop.ctl().windows;
      await wm.activate(await wm.resolve(a.window));
      return text({ ok: true });
    }));
  mcp.registerTool('launch_app', {
    description: 'Launch a GUI application on the desktop (e.g. "xterm", "firefox-esr").',
    inputSchema: { command: z.string(), args: z.array(z.string()).optional() },
  }, async (a) => wrap(async () => {
    if (!config.exec) throw new ApiError('permission_denied', 'launching apps is disabled');
    const r = await launchDetached(desktop.x.displayName, a.command, a.args);
    await new Promise((res) => setTimeout(res, 500));
    return text(r);
  }));

  const a11y = () => { if (!ctx.a11y) throw new ApiError('feature_unsupported', 'accessibility disabled', { feature: 'a11y' }); return ctx.a11y; };
  mcp.registerTool('get_ui_tree', {
    description: 'Accessibility tree (flat, pre-order) for a window or the whole desktop. Use element_id + snapshot_id with ui_action.',
    inputSchema: { window: z.string().optional(), max_depth: z.number().int().optional(), max_nodes: z.number().int().max(5000).optional() },
  }, async (a) => wrap(async () => {
    const t = await a11y().tree({ window: a.window, max_depth: a.max_depth, max_nodes: a.max_nodes ?? 800 });
    return text({ ...t, nodes: t.nodes.map(({ description: _d, app: _a, ...n }) => n) });
  }));
  mcp.registerTool('find_element', {
    description: 'Find accessible elements by role (button, text_field, menuitem, …), name, or states.',
    inputSchema: { role: z.string().optional(), name: z.string().optional(), name_contains: z.string().optional(), value_contains: z.string().optional(), states: z.array(z.string()).optional(), window: z.string().optional(), max_results: z.number().int().max(200).optional() },
  }, async (a) => wrap(async () => text(await a11y().find(a))));
  mcp.registerTool('ui_action', {
    description: 'Perform an accessibility action on an element: press, focus, set_value, or any action name it lists. Does not move the mouse.',
    inputSchema: { snapshot_id: z.string(), element_id: z.string(), action: z.string(), value: z.string().optional() },
  }, async (a) => wrap(async () => text(await a11y().act(a.snapshot_id, a.element_id, a.action, a.value))));

  mcp.registerTool('get_clipboard', { description: 'Read the clipboard.', inputSchema: {} },
    async () => wrap(async () => text(await desktop.ctl().clipboard.read())));
  mcp.registerTool('set_clipboard', { description: 'Set the clipboard text.', inputSchema: { text: z.string() } },
    async (a) => wrap(async () => text({ generation: await desktop.ctl().clipboard.write({ text: a.text }) })));

  if (config.exec) {
    const jobs = jobsFor(config, desktop);
    mcp.registerTool('run_command', {
      description: 'Run a shell command in the desktop environment (non-interactive). Waits up to wait_ms (default 25 s) ' +
        'and returns {state, exit_code, stdout, stderr}. If it is still going, state is "running" with a job_id: ' +
        'the command keeps running, and you call command_output to wait for it. Use this for long commands (installs, builds) too.',
      inputSchema: {
        command: z.string(), cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(24 * 3_600_000).optional().describe('Kill the command after this long (default 1 h)'),
        wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe(`How long to wait before handing off (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`),
      },
    }, async (a) => wrap(async () => {
      const id = await jobs.start({ command: a.command, cwd: a.cwd, timeout_ms: a.timeout_ms });
      return text(present(await jobs.wait(id, a.wait_ms ?? DEFAULT_WAIT_MS)));
    }));
    mcp.registerTool('command_output', {
      description: 'Wait for a command started by run_command (by job_id) and return its state and output. ' +
        'Pass stdout_offset/stderr_offset from the previous result to get only new output. cancel=true kills it.',
      inputSchema: {
        job_id: z.string(),
        wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe(`Default ${DEFAULT_WAIT_MS}`),
        stdout_offset: z.number().int().min(0).optional(), stderr_offset: z.number().int().min(0).optional(),
        cancel: z.boolean().optional(),
      },
    }, async (a) => wrap(async () => {
      if (a.cancel) return text(present(await jobs.cancel(a.job_id)));
      return text(present(await jobs.wait(a.job_id, a.wait_ms ?? DEFAULT_WAIT_MS, { stdout: a.stdout_offset, stderr: a.stderr_offset })));
    }));
    mcp.registerTool('read_file', {
      description: 'Read a text file (up to 1 MiB).',
      inputSchema: { path: z.string() },
    }, async (a) => wrap(async () => {
      const p = safePath(config.fsRoot, a.path);
      const st = await stat(p);
      if (st.size > 1 << 20) throw new ApiError('limit_exceeded', 'file larger than 1 MiB; use the HTTP fs API');
      return text(await readFile(p, 'utf8'));
    }));
    mcp.registerTool('write_file', {
      description: 'Write a text file (creates parent directories).',
      inputSchema: { path: z.string(), content: z.string() },
    }, async (a) => wrap(async () => {
      const p = safePath(config.fsRoot, a.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, a.content);
      return text({ ok: true, path: p, bytes: Buffer.byteLength(a.content) });
    }));
  }
  return mcp;
}

const SESSION_IDLE_MS = 30 * 60_000;

export default async function mcpRoutes(app: FastifyInstance, ctx: AppContext) {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; principal: Principal; lastUsed: number }>();
  const drop = (id: string) => {
    const e = sessions.get(id);
    if (!e) return;
    sessions.delete(id);
    m.mcpSessions.dec();
    ctx.desktop.presence.leaveByKey(`mcp:${id}`);
    void e.transport.close().catch(() => undefined);
  };
  // Reap sessions whose client vanished without DELETE.
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of sessions) if (now - e.lastUsed > SESSION_IDLE_MS) drop(id);
  }, 60_000);
  reaper.unref();

  const handler = async (req: any, reply: any) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let entry = sid ? sessions.get(sid) : undefined;
    if (!entry) {
      if (sid) {
        return reply.code(404).send({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown MCP session' }, id: null });
      }
      if (req.method !== 'POST') {
        return reply.code(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'missing mcp-session-id' }, id: null });
      }
      const principal: Principal = { kind: 'agent', name: 'agent' };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          principal.id = `mcp:${id}`;
          sessions.set(id, { transport, principal, lastUsed: Date.now() });
          m.mcpSessions.inc();
        },
      } as any);
      const mcp = buildMcp(ctx, () => principal);
      mcp.server.oninitialized = () => {
        const ci = mcp.server.getClientVersion();
        principal.name = ci?.name ? String(ci.name).slice(0, 64) : 'agent';
        if (principal.id) ctx.desktop.presence.join({ name: principal.name, kind: 'agent', key: principal.id });
      };
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) drop(id);
      };
      await mcp.connect(transport);
      entry = { transport, principal, lastUsed: Date.now() };
    }
    entry.lastUsed = Date.now();
    reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw, req.body);
    if (req.method === 'DELETE' && sid) drop(sid);
  };

  app.post('/mcp', { schema: { hide: true } }, handler);
  app.get('/mcp', { schema: { hide: true } }, handler);
  app.delete('/mcp', { schema: { hide: true } }, handler);
  app.addHook('onClose', async () => {
    clearInterval(reaper);
    for (const id of [...sessions.keys()]) drop(id);
  });
}
