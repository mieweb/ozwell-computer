import Fastify, { type FastifyInstance } from 'fastify';
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
import webRoutes, { loginPage } from './web/routes.js';
import vncRoutes from './vnc/routes.js';
import mcpRoutes from './mcp/server.js';
import type { A11y } from './a11y/atspi.js';
import type { Updater } from './update.js';
import { m, render as renderMetrics } from './metrics.js';

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

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as any,
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: true,
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: false, allErrors: false } },
  });

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

  registerAuth(app, { token: ctx.token, loginPage });

  const novncDir = dirname(dirname(require.resolve('@novnc/novnc'))); // exports → core/rfb.js
  await app.register(fastifyStatic, { root: novncDir, prefix: '/novnc/', decorateReply: false, index: false });
  // Vite builds the viewer into dist/web/static; resolved from dist/ or src/ (npm run dev).
  const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web', 'static');
  await app.register(fastifyStatic, { root: staticDir, prefix: '/static/', decorateReply: false, index: false });

  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/health') return;
    m.httpSeconds.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });
  app.get('/api/v1/metrics', {
    schema: { tags: ['system'], summary: 'Prometheus metrics (text exposition format)' },
    logLevel: 'warn', // scraped every few seconds
  }, async (_req, reply) => {
    const { body, contentType } = await renderMetrics();
    return reply.header('content-type', contentType).header('cache-control', 'no-store').send(body);
  });

  await app.register(async (s) => coreRoutes(s, ctx));
  await app.register(async (s) => windowRoutes(s, ctx));
  await app.register(async (s) => execRoutes(s, ctx));
  await app.register(async (s) => a11yRoutes(s, ctx));
  await app.register(async (s) => vncRoutes(s, ctx));
  await app.register(async (s) => mcpRoutes(s, ctx));
  await app.register(async (s) => webRoutes(s, ctx));
  return app;
}
