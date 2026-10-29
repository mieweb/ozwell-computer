import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'";

// The React app (web/, built by Vite into dist/web/static) loads its data from the API, so
// the shell holds nothing secret and is served with or without credentials.
export default async function webRoutes(app: FastifyInstance) {
  const page = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', CSP)
      .sendFile('index.html', { cacheControl: false });
  app.get('/', { schema: { hide: true } }, page);
  app.get('/index.html', { schema: { hide: true } }, page);
  app.get('/favicon.ico', { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());
}
