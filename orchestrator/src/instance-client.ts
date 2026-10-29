// Minimal MCP Streamable-HTTP client for calling an instance's tools.
//
// Plain JSON-RPC over fetch: no background SSE stream (the SDK client's stream abort
// surfaces as an unhandled error). Sessions are cached per instance+user as an
// optimisation only; a lost session (instance restarted) is simply re-initialised.
const PROTOCOL = '2025-06-18';
const IDLE_MS = 5 * 60_000;
// Longer than any tool's own limit (run_command allows timeout_ms up to 10 min).
const CALL_TIMEOUT_MS = 11 * 60_000;

interface Session { id: string; protocol: string; lastUsed: number; url: string; token: string }

export class InstanceError extends Error {
  readonly reason: string;
  /** A proxy 503 or a refused connection: the computer may have been stopped. */
  readonly unreachable: boolean;
  constructor(reason: string, message: string, unreachable = false) { super(message); this.reason = reason; this.unreachable = unreachable; }
}

export class InstanceClient {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private reaper: NodeJS.Timeout;

  constructor() {
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [k, s] of this.sessions) if (now - s.lastUsed > IDLE_MS) { this.sessions.delete(k); void this.end(s); }
    }, 60_000);
    this.reaper.unref();
  }

  close() {
    clearInterval(this.reaper);
    for (const s of this.sessions.values()) void this.end(s);
    this.sessions.clear();
  }

  private async post(url: string, token: string, body: object, session?: Session) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session.id, 'mcp-protocol-version': session.protocol } : {}),
    };
    let res: Response;
    try {
      res = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (e) {
      throw new InstanceError('target_unavailable', `cannot reach the computer: ${(e as Error).message}`, (e as any).cause?.code === 'ECONNREFUSED');
    }
    // Before the body: a proxy's 503 may be HTML or a JSON-RPC-looking error.
    if (res.status === 503) throw new InstanceError('target_unavailable', 'the computer is unavailable (HTTP 503)', true);
    const text = await res.text();
    if (!res.ok) return { res, msg: null };
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    return { res, msg: json ? JSON.parse(json) : null };
  }

  private async open(url: string, token: string, clientName: string): Promise<Session> {
    const init = await this.post(url, token, {
      jsonrpc: '2.0', id: ++this.seq, method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: clientName, version: '1' } },
    });
    if (init.res.status === 401) throw new InstanceError('unauthenticated', 'the computer rejected its token');
    const id = init.res.headers.get('mcp-session-id');
    if (!init.res.ok || !id) throw new InstanceError('target_unavailable', `MCP initialize failed (HTTP ${init.res.status})`);
    const s: Session = { id, protocol: init.msg?.result?.protocolVersion ?? PROTOCOL, lastUsed: Date.now(), url, token };
    await this.post(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, s);
    return s;
  }

  private async end(s: Session) {
    await fetch(`${s.url}/mcp`, {
      method: 'DELETE', headers: { authorization: `Bearer ${s.token}`, 'mcp-session-id': s.id, 'mcp-protocol-version': s.protocol },
    }).catch(() => undefined);
  }

  /** Call a tool on an instance; returns the MCP CallToolResult. */
  async callTool(key: string, url: string, token: string, clientName: string, name: string, args: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let s = this.sessions.get(key);
      if (!s || s.url !== url || s.token !== token) {
        s = await this.open(url, token, clientName);
        this.sessions.set(key, s);
      }
      s.lastUsed = Date.now();
      const r = await this.post(url, token, { jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } }, s);
      if (r.res.status === 404 || r.res.status === 400) { this.sessions.delete(key); continue; } // session gone: re-init once
      if (!r.res.ok) throw new InstanceError('target_unavailable', `tool call failed (HTTP ${r.res.status})`);
      if (r.msg?.error) throw new InstanceError('internal', r.msg.error.message ?? 'tool call failed');
      if (!r.msg?.result) throw new InstanceError('target_unavailable', 'tool call returned no result');
      return r.msg.result;
    }
    throw new InstanceError('target_unavailable', 'the computer keeps dropping its MCP session');
  }
}
