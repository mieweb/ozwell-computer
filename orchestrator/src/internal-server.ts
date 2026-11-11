// The internal listener (ORCHESTRATOR_INTERNAL_PORT): scrape and service-discovery routes
// for vmagent. No auth: bind it to loopback or a private compose network, never publicly.
//
//   GET /metrics                 the orchestrator's own metrics
//   GET /sd                      Prometheus http_sd targets, one per running computer
//   GET /instances/:id/metrics   scrape proxy: the computer's /api/v1/metrics with its token
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Metrics } from './metrics.ts';
import type { Computer, Provider } from './providers/types.ts';

export interface InternalServerOptions {
  metrics: Metrics;
  /** Needed for /sd and the scrape proxy; without it only /metrics is served. */
  provider?: Provider;
  /** host:port vmagent uses to reach this listener; put in every /sd target. */
  sdAddress?: string;
  /** How long a /sd answer is reused (default 15 s). */
  sdCacheMs?: number;
  /** Instance scrape timeout (default 10 s). */
  scrapeTimeoutMs?: number;
  logger?: boolean | object;
}

export interface SdTarget { targets: string[]; labels: Record<string, string> }

/** One target per running computer, pointed at this listener's scrape proxy. */
export function sdTargets(computers: Computer[], provider: string, address: string): SdTarget[] {
  return computers
    .filter((c) => !c.stopped && c.internalUrl && c.token)
    .map((c) => ({
      targets: [address],
      labels: { instance_id: c.id, provider, user: c.owner, __metrics_path__: `/instances/${encodeURIComponent(c.id)}/metrics` },
    }));
}

export async function buildInternalServer(opts: InternalServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const noTrace = { config: { otel: false } }; // scrapes every few seconds: not worth a trace each

  app.get('/health', async (_req, reply) => reply.code(204).send());
  app.get('/metrics', noTrace, async (_req, reply) =>
    reply.type(opts.metrics.registry.contentType).send(await opts.metrics.registry.metrics()));

  const provider = opts.provider;
  if (!provider) return app;

  const address = opts.sdAddress ?? '127.0.0.1:8091';
  const cacheMs = opts.sdCacheMs ?? 15_000;
  let cache: { at: number; body: SdTarget[] } | undefined;
  let inflight: Promise<SdTarget[]> | undefined;

  app.get('/sd', noTrace, async (req, reply) => {
    if (!cache || Date.now() - cache.at >= cacheMs) {
      // Concurrent discovery requests share one provider listing.
      inflight ??= provider.listAll()
        .then((all) => { cache = { at: Date.now(), body: sdTargets(all, provider.scheme, address) }; return cache.body; })
        .finally(() => { inflight = undefined; });
      try {
        await inflight;
      } catch (e) {
        // vmagent keeps its last good target list when discovery fails.
        req.log.warn({ err: (e as Error).message }, 'service discovery failed');
        return reply.code(502).send({ error: { reason: 'provider_error', message: (e as Error).message } });
      }
    }
    return reply.send(cache!.body);
  });

  app.get<{ Params: { id: string } }>('/instances/:id/metrics', noTrace, async (req, reply) => {
    let c: Computer | null;
    try {
      c = await provider.get(req.params.id);
    } catch (e) {
      return reply.code(503).send({ error: { reason: 'provider_error', message: (e as Error).message } });
    }
    if (!c) return reply.code(404).send({ error: { reason: 'not_found', message: `no computer ${req.params.id}` } });
    if (c.stopped || !c.internalUrl || !c.token) {
      return reply.code(503).send({ error: { reason: 'target_unavailable', message: `computer ${c.id} is ${c.status}` } });
    }
    let res: Response;
    try {
      res = await fetch(`${c.internalUrl}/api/v1/metrics`, {
        headers: { authorization: `Bearer ${c.token}`, accept: req.headers.accept ?? 'text/plain' },
        signal: AbortSignal.timeout(opts.scrapeTimeoutMs ?? 10_000),
      });
    } catch (e) {
      return reply.code(503).send({ error: { reason: 'target_unavailable', message: `cannot reach ${c.id}: ${(e as Error).message}` } });
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return reply.code(503).send({ error: { reason: 'target_unavailable', message: `computer ${c.id} answered HTTP ${res.status}` } });
    }
    reply.type(res.headers.get('content-type') ?? 'text/plain; version=0.0.4');
    return reply.send(Readable.fromWeb(res.body as any));
  });

  return app;
}
