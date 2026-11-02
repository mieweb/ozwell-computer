// HTTP front: PSK bearer auth (Ozwell's workspace MCP config), Ozwell user headers,
// stateless Streamable-HTTP MCP at /mcp, and /health.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, type OrchestratorDeps } from './mcp.ts';
import type { Requester } from './providers/types.ts';
import { createGateway } from './gateway.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();
export const tokenOk = (expected: string, given: string | undefined) =>
  typeof given === 'string' && given.length > 0 && timingSafeEqual(digest(expected), digest(given));

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

export function requesterOf(req: FastifyRequest): Requester | null {
  const id = header(req, 'x-ozwell-user-id');
  if (!id) return null;
  return {
    id: id.slice(0, 256),
    email: header(req, 'x-ozwell-user-email')?.slice(0, 256),
    name: header(req, 'x-ozwell-user-name')?.slice(0, 128),
    agentName: header(req, 'x-ozwell-agent-name')?.slice(0, 64),
  };
}

export interface ServerOptions extends OrchestratorDeps {
  /** Pre-shared key Ozwell sends as `Authorization: Bearer <psk>`; null disables auth (dev only). */
  psk: string | null;
  logger?: boolean | object;
  /** Wildcard guest origin; the same listener serves their wake gateway. */
  gatewayUrl?: string;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  if (opts.gatewayUrl && !opts.lifecycle) throw new Error('a wake gateway requires the lifecycle controller');
  const gateway = opts.gatewayUrl ? createGateway({ provider: opts.provider, lifecycle: opts.lifecycle!, publicUrl: opts.gatewayUrl }) : undefined;
  const app = Fastify({
    logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024,
    ...(gateway ? { serverFactory: (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      // The proxy must receive the original stream before Fastify parses a body.
      const server = createServer((req, res) => {
        void gateway.handler(req, res).then((handled) => { if (!handled) handler(req, res); }).catch(() => {
          if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('Gateway unavailable');
        });
      });
      server.on('upgrade', (req, socket, head) => {
        void gateway.upgrade(req, socket, head).then((handled) => {
          if (!handled) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        }).catch(() => socket.destroy());
      });
      return server;
    } } : {}),
  });
  // Inject and then bind logging so library users get the same lifecycle events
  // as CLI deployments, without logging instance credentials or request URLs.
  opts.lifecycle?.setLogger(app.log);
  app.addHook('onReady', async () => opts.lifecycle?.start());
  app.addHook('preClose', async () => { await gateway?.close(); await opts.lifecycle?.close(); });

  app.get('/health', async (_req, reply) => reply.code(204).send());

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    if (opts.psk !== null) {
      const m = /^Bearer\s+(.+)$/i.exec(header(req, 'authorization') ?? '');
      if (!tokenOk(opts.psk, m?.[1])) {
        return reply.code(401).header('www-authenticate', 'Bearer').send({ error: { reason: 'unauthenticated', message: 'missing or invalid token' } });
      }
    }
    // Only meaningful once authenticated: the user headers are trusted from Ozwell.
    if (req.url.startsWith('/mcp') && !requesterOf(req)) {
      return reply.code(400).send({ error: { reason: 'invalid_request', message: 'X-Ozwell-User-Id header is required' } });
    }
  });

  const handle = async (req: FastifyRequest, reply: any) => {
    const user = requesterOf(req)!;
    const server = buildMcpServer(opts, user);
    // Stateless mode: no MCP session; each request stands alone. Responses are SSE, not
    // buffered JSON, so headers go out immediately: clients such as Ozwell abort if
    // headers take longer than 15 s, and tool calls (run_command, apps) often do.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', handle);
  // No server-initiated streams or sessions in stateless mode.
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send());
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send());

  app.addHook('onClose', async () => opts.client.close());
  return app;
}
