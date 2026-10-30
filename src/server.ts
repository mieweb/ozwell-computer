import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
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
import { m, render as renderMetrics, setCpus } from './metrics.js';
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

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  setCpus(ctx.config.cpus);
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as any,
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

  await app.register(async (s) => coreRoutes(s, ctx));
  const build = webBuild(staticDir);
  await app.register(async (s) => windowRoutes(s, ctx, build));
  await app.register(async (s) => execRoutes(s, ctx));
  await app.register(async (s) => a11yRoutes(s, ctx));
  await app.register(async (s) => vncRoutes(s, ctx));
  await app.register(async (s) => mcpRoutes(s, ctx));
  await app.register(async (s) => webRoutes(s, ctx));
  return app;
}
