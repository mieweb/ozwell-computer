import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { logRoutes } from './routes/logs.js';
import { parseTraceparent } from './trace-context.js';
import { traceRoutes } from './routes/traces.js';
import { SpanKind, tracer, type Span } from './tracing.js';
import fastifyWebsocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { registerAuth, redactUrl } from './auth/plugin.js';
import { ApiError, toApiError } from './errors.js';
import type { Desktop } from './desktop.js';
import coreRoutes from './routes/core.js';
import windowRoutes from './routes/windows.js';
import execRoutes from './routes/exec.js';
import a11yRoutes from './routes/a11y.js';
import webRoutes, { webBuild } from './web/routes.js';
import vncRoutes from './vnc/routes.js';
import mcpRoutes from './mcp/server.js';
import type { A11y } from './a11y/atspi.js';
import type { Updater } from './update.js';
import { m, render as renderMetrics, setCpus, setVersion } from './metrics.js';
import { errors, media } from './routes/schemas.js';

const require = createRequire(import.meta.url);
export const VERSION: string = require('../package.json').version;

export interface AppContext {
  config: Config;
  desktop: Desktop;
  token: string | null;
  version: string;
  a11y: A11y | null;
  ptyAvailable: boolean;
  updater: Updater | null;
  log: Logger;
}

const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80));

/** Path and values of the first difference between two JSON values, or null when equal. */
function difference(sent: unknown, returned: unknown, path = ''): string | null {
  if (sent === returned) return null;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (!isObj(sent) || !isObj(returned) || Array.isArray(sent) !== Array.isArray(returned)) {
    return `${path || '(root)'}: sent ${show(sent)}, handler returned ${show(returned)}`;
  }
  for (const k of new Set([...Object.keys(sent), ...Object.keys(returned)])) {
    const d = difference(sent[k], returned[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Fail (500) any JSON reply that its response schema serialized differently from what the handler returned. */
export function strictResponses(app: FastifyInstance) {
  const returned = new WeakMap<FastifyRequest, unknown>();
  app.addHook('preSerialization', async (req, _reply, payload) => {
    returned.set(req, JSON.parse(JSON.stringify(payload)));
    return payload;
  });
  app.addHook('onSend', async (req, _reply, payload) => {
    if (!returned.has(req) || typeof payload !== 'string') return payload;
    const want = returned.get(req);
    returned.delete(req);
    const d = difference(JSON.parse(payload), want);
    if (d) throw new Error(`${req.method} ${req.routeOptions.url}: the response schema changed the reply at ${d}`);
    return payload;
  });
}

/**
 * Routes that are polled, scraped or long-lived (streams, websockets) get no request span:
 * tracing them would fill the span buffer with background noise (issue #64, requirement 6).
 */
export const UNTRACED_ROUTES = new Set([
  'GET /health', 'GET /api/v1/metrics', 'GET /api/v1/logs/entries', 'GET /api/v1/traces',
  'GET /api/v1/events', 'GET /api/v1/presence', 'POST /api/v1/presence/cursor', 'GET /api/v1/pty',
  'GET /websockify', 'GET /mcp',
]);

const requestSpans = new WeakMap<FastifyRequest, Span>();

/** A SERVER span per API/MCP request, continuing the caller's traceparent, active while the request runs. */
export function traceRequests(app: FastifyInstance) {
  app.addHook('onRequest', (req, _reply, done) => {
    const route = req.routeOptions?.url;
    if (!route || !(route.startsWith('/api/') || route === '/mcp') || UNTRACED_ROUTES.has(`${req.method} ${route}`)) return done();
    const span = tracer.start(`${req.method} ${route}`, {
      kind: SpanKind.SERVER, root: true, traceparent: req.headers.traceparent,
      attrs: { 'http.request.method': req.method, 'http.route': route },
    });
    if (!span) return done();
    requestSpans.set(req, span);
    // Run the rest of the request (hooks, handler) with the span active.
    tracer.runWith(span, done);
  });
  app.addHook('onResponse', async (req, reply) => {
    const span = requestSpans.get(req);
    if (!span) return;
    requestSpans.delete(req);
    span.set({ 'http.response.status_code': reply.statusCode });
    if (reply.statusCode >= 500) span.fail(`HTTP ${reply.statusCode}`);
    span.end();
  });
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  setCpus(ctx.config.cpus);
  setVersion(ctx.version);
  tracer.setResource({ 'service.version': ctx.version });
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as any,
    // Requests from the orchestrator carry its trace context: put the ids on every log line.
    childLoggerFactory(logger, bindings, opts, rawReq) {
      const ids = parseTraceparent(rawReq.headers.traceparent);
      return logger.child(ids ? { ...bindings, ...ids } : bindings, opts);
    },
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: true,
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: false, allErrors: false } },
  });
  if (ctx.config.strictResponses) strictResponses(app);

  app.setErrorHandler((err, req, reply) => {
    const e = toApiError(err);
    if (e.reason === 'internal') req.log.error({ err }, 'request failed');
    if (e.reason === 'unauthenticated') reply.header('www-authenticate', 'Bearer');
    reply.code(e.status).send(e.toBody());
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(new ApiError('target_unavailable', `no route for ${req.method} ${redactUrl(req.url)}`).toBody());
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'ozwell-computer', version: ctx.version, description: 'Control an X11 desktop over HTTP' },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
          header: { type: 'apiKey', in: 'header', name: 'X-Auth-Token' },
          query: { type: 'apiKey', in: 'query', name: 'token' },
          cookie: { type: 'apiKey', in: 'cookie', name: 'ozwell_computer_token' },
        },
      },
      security: [{ bearer: [] }, { header: [] }, { query: [] }, { cookie: [] }],
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/api/docs' });

  registerAuth(app, { token: ctx.token });

  const novncDir = dirname(dirname(require.resolve('@novnc/novnc'))); // exports → core/rfb.js
  await app.register(fastifyStatic, { root: novncDir, prefix: '/novnc/', decorateReply: false, index: false });
  // Vite builds the viewer into dist/web/static; resolved from dist/ or src/ (npm run dev).
  const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web', 'static');
  await app.register(fastifyStatic, { root: staticDir, prefix: '/static/', index: false });

  traceRequests(app);

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/health') return;
    m.httpSeconds.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });
  app.get('/api/v1/metrics', {
    schema: {
      tags: ['system'], summary: 'Prometheus metrics (text exposition format)',
      description: 'Node process metrics, container and per-command memory, HTTP request durations, VNC/MCP/SSE sessions, MCP tool calls, screenshot timings and X connection state.',
      response: { 200: media('Metrics in the Prometheus text format', ['text/plain'], { type: 'string' }), ...errors },
    },
    logLevel: 'warn', // scraped every few seconds
  }, async (_req, reply) => {
    const { body, contentType } = await renderMetrics();
    return reply.header('content-type', contentType).header('cache-control', 'no-store').send(body);
  });

  await app.register(async (s) => logRoutes(s));
  await app.register(async (s) => traceRoutes(s));
  await app.register(async (s) => coreRoutes(s, ctx));
  // Read per hello, so a viewer rebuilt under a running server (dev compose) reports its new id.
  await app.register(async (s) => windowRoutes(s, ctx, () => webBuild(staticDir)));
  await app.register(async (s) => execRoutes(s, ctx));
  await app.register(async (s) => a11yRoutes(s, ctx));
  await app.register(async (s) => vncRoutes(s, ctx));
  await app.register(async (s) => mcpRoutes(s, ctx));
  await app.register(async (s) => webRoutes(s, ctx));
  return app;
}
