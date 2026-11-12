// The internal listener (ORCHESTRATOR_INTERNAL_PORT): scrape and service-discovery routes
// for vmagent. With a token (ORCHESTRATOR_INTERNAL_TOKEN) every route but /health needs
// `Authorization: Bearer <token>`; without one, bind it to loopback only.
//
//   GET /metrics                 the orchestrator's own metrics
//   GET /sd                      Prometheus http_sd targets, one per running computer
//   GET /instances/:id/metrics   scrape proxy: the computer's /api/v1/metrics with its token
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { tokenOk } from './server.ts';
import { untraced } from './untraced.ts';
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
  /** How long /metrics waits for a computer listing before serving the last one (default 2 s). */
  metadataWaitMs?: number;
  /** Instance scrape timeout (default 10 s). */
  scrapeTimeoutMs?: number;
  /** Bearer token required on every route but /health; undefined means none. */
  token?: string;
  logger?: boolean | object;
}

export interface SdTarget { targets: string[]; labels: Record<string, string> }

/** One target per running computer, pointed at this listener's scrape proxy. */
export function sdTargets(computers: Computer[], provider: string, address: string): SdTarget[] {
  return computers
    .filter((c) => !c.stopped && c.internalUrl && c.token)
    .map((c) => ({
      targets: [address],
      // Identity only: these labels go on every scraped series, and a label that changes
      // starts new series. Metadata (owner, display name, ...) is ozwell_orchestrator_computer_info.
      labels: { instance_id: c.id, provider, __metrics_path__: `/instances/${encodeURIComponent(c.id)}/metrics` },
    }));
}

export async function buildInternalServer(opts: InternalServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const noTrace = { config: { otel: false } }; // scrapes every few seconds: not worth a trace each

  app.get('/health', async (_req, reply) => reply.code(204).send());
  if (opts.token) {
    const token = opts.token;
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/health') return;
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
      if (!tokenOk(token, m?.[1])) {
        return reply.code(401).header('www-authenticate', 'Bearer').send({ error: { reason: 'unauthenticated', message: 'missing or invalid token' } });
      }
    });
  }

  const provider = opts.provider;
  // One provider listing, shared by /sd and the computer metadata in /metrics, reused for
  // sdCacheMs; concurrent requests share one call.
  const cacheMs = opts.sdCacheMs ?? 15_000;
  let cache: { at: number; computers: Computer[] } | undefined;
  let inflight: Promise<Computer[]> | undefined;
  const listing = provider && ((): Promise<Computer[]> => {
    if (cache && Date.now() - cache.at < cacheMs) return Promise.resolve(cache.computers);
    inflight ??= provider.listAll()
      .then((computers) => {
        cache = { at: Date.now(), computers };
        opts.metrics.setComputers(computers, provider.scheme);
        return computers;
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  });

  app.get('/metrics', noTrace, (_req, reply) => untraced(async () => {
    // Refresh the computer metadata, but never hold the scrape for it: a slow or failing
    // provider leaves the last snapshot in place while the refresh carries on.
    const refresh = listing?.().catch(() => undefined);
    if (refresh) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([refresh, new Promise((r) => { timer = setTimeout(r, opts.metadataWaitMs ?? 2000); })]);
      clearTimeout(timer);
    }
    return reply.type(opts.metrics.registry.contentType).send(await opts.metrics.registry.metrics());
  }));

  if (!provider) return app;

  const address = opts.sdAddress ?? '127.0.0.1:8091';
  app.get('/sd', noTrace, (req, reply) => untraced(async () => {
    try {
      return reply.send(sdTargets(await listing!(), provider!.scheme, address));
    } catch (e) {
      // vmagent keeps its last good target list when discovery fails.
      req.log.warn({ err: (e as Error).message }, 'service discovery failed');
      return reply.code(502).send({ error: { reason: 'provider_error', message: (e as Error).message } });
    }
  }));

  app.get<{ Params: { id: string } }>('/instances/:id/metrics', noTrace, (req, reply) => untraced(async () => {
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
  }));

  return app;
}
