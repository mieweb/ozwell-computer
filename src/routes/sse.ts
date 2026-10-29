import { once } from 'node:events';
import type { FastifyReply } from 'fastify';
import { m } from '../metrics.js';

const MAX_BUFFERED = 1 << 20;

/**
 * Take over the reply as a server-sent event stream with keepalives; `signal` aborts when the client
 * goes away. Producers that can pause await drained(); a client more than MAX_BUFFERED behind is dropped.
 */
export function openSse(reply: FastifyReply, route: string) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const ac = new AbortController();
  const send = (type: string, data: unknown, id?: string | number) => {
    if (ac.signal.aborted) return;
    res.write(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.writableLength > MAX_BUFFERED) res.destroy();
  };
  const drained = (signal = ac.signal) =>
    (res.writableNeedDrain ? once(res, 'drain', { signal }).then(() => undefined, () => undefined) : Promise.resolve());
  const ka = setInterval(() => send('keepalive', { ts: Date.now() }), 15_000);
  const started = performance.now();
  const close = () => {
    if (ac.signal.aborted) return;
    clearInterval(ka);
    ac.abort();
    // hijacked replies skip the onResponse hook, so record the stream here
    m.httpSeconds.observe({ method: 'GET', route, status: '200' }, (performance.now() - started) / 1000);
  };
  res.on('close', close);
  // The client may have left while the route was still awaiting something; `close` won't fire again.
  if (res.destroyed || res.closed || reply.request.raw.socket?.destroyed) close();
  return { send, drained, signal: ac.signal, end: () => res.end() };
}

export type Sse = ReturnType<typeof openSse>;

/** Open /api/v1/events streams by the `stream_id` in their `hello` event. */
export const eventStreams = new Map<string, Sse>();
