// Wraps any Provider so every method call is a `provider.<method>` span (and, later, timed
// into metrics through `onCall`). Provider implementations need no changes.
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import type { Computer, CreateOptions, Provider } from './providers/types.ts';

export type ProviderMethod = 'list' | 'listAll' | 'get' | 'create' | 'start' | 'destroy';
export type CallOutcome = 'ok' | 'error';

export interface ProviderCallObserver {
  (call: { provider: string; method: ProviderMethod; seconds: number; outcome: CallOutcome }): void;
}

const tracer = trace.getTracer('ozwell-computer-orchestrator');

export function instrumentProvider(inner: Provider, onCall?: ProviderCallObserver): Provider {
  const scheme = inner.scheme;
  const run = <T>(method: ProviderMethod, attrs: Attributes, fn: () => Promise<T>, after?: (r: T) => Attributes): Promise<T> =>
    tracer.startActiveSpan(`provider.${method}`, { attributes: { 'ozwell.provider': scheme, ...attrs } }, async (span) => {
      const t0 = performance.now();
      let outcome: CallOutcome = 'ok';
      try {
        const r = await fn();
        if (after) span.setAttributes(after(r));
        return r;
      } catch (e) {
        outcome = 'error';
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        span.setAttribute('error.type', (e as Error).name || 'Error');
        throw e;
      } finally {
        span.end();
        onCall?.({ provider: scheme, method, seconds: (performance.now() - t0) / 1000, outcome });
      }
    });
  const describe = (c: Computer | null): Attributes =>
    c ? { 'ozwell.instance_id': c.id, 'ozwell.status': c.status, 'ozwell.stopped': c.stopped } : { 'ozwell.found': false };

  return {
    scheme,
    list: (owner: string) => run('list', { 'enduser.id': owner }, () => inner.list(owner), (r) => ({ 'ozwell.count': r.length })),
    listAll: () => run('listAll', {}, () => inner.listAll(), (r) => ({ 'ozwell.count': r.length })),
    get: (id: string) => run('get', { 'ozwell.instance_id': id }, () => inner.get(id), describe),
    create: (opts: CreateOptions) => run('create', { 'enduser.id': opts.owner.id }, () => inner.create(opts), describe),
    start: (id: string) => run('start', { 'ozwell.instance_id': id }, () => inner.start(id), describe),
    destroy: (id: string) => run('destroy', { 'ozwell.instance_id': id }, () => inner.destroy(id)),
  };
}
