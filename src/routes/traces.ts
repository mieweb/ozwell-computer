// GET /api/v1/traces: finished spans from the in-memory buffer (src/tracing.ts) as OTLP
// JSON. The orchestrator pulls them into VictoriaTraces; the computer doesn't push.
import type { FastifyInstance } from 'fastify';
import { tracer as defaultTracer, type Tracer } from '../tracing.js';
import { errors, media } from './schemas.js';

/** Spans per response, at most. */
export const MAX_TRACE_SPANS = 2000;
/** Approximate JSON bytes per response, at most (the orchestrator also caps what it reads). */
export const MAX_TRACE_BYTES = 4 * 1024 * 1024;

export const TRACE_HEADERS = { cursor: 'ozwell-trace-cursor', dropped: 'ozwell-trace-dropped', more: 'ozwell-trace-more' } as const;

export async function traceRoutes(app: FastifyInstance, opts: { tracer?: Tracer } = {}) {
  const t = opts.tracer ?? defaultTracer;
  app.get('/api/v1/traces', {
    schema: {
      tags: ['system'],
      summary: 'Finished trace spans (OTLP JSON)',
      description:
        'Spans this computer recorded for the requests and MCP tool calls it served, as an OTLP/JSON ExportTraceServiceRequest. ' +
        'Spans continue the caller\'s W3C traceparent. They are kept in a bounded in-memory buffer (oldest dropped first, lost on restart). ' +
        `Page with the ${TRACE_HEADERS.cursor} response header passed back as ?cursor=; ${TRACE_HEADERS.more}: 1 means more spans are waiting, ` +
        `and ${TRACE_HEADERS.dropped} counts spans dropped from the buffer since the given cursor. A missing or unknown cursor returns the buffer from its start; cursor=end returns no spans and a cursor at the end of the buffer.`,
      querystring: {
        type: 'object', additionalProperties: false, properties: {
          cursor: { type: 'string', maxLength: 64, description: `Value of ${TRACE_HEADERS.cursor} from the previous response, or end` },
          limit: { type: 'integer', minimum: 1, maximum: MAX_TRACE_SPANS, description: `Spans per response (default and maximum ${MAX_TRACE_SPANS})` },
        },
      },
      response: {
        200: media('OTLP/JSON ExportTraceServiceRequest', ['application/json'], {
          type: 'object', description: 'ExportTraceServiceRequest (opentelemetry-proto, JSON encoding)',
          properties: { resourceSpans: { type: 'array', description: 'Spans grouped by resource and scope', items: { type: 'object' } } },
        }, {
          headers: {
            [TRACE_HEADERS.cursor]: { description: 'Pass back as ?cursor= for the next spans', schema: { type: 'string' } },
            [TRACE_HEADERS.more]: { description: '1 when more spans are waiting', schema: { type: 'string' } },
            [TRACE_HEADERS.dropped]: { description: 'Spans dropped from the full buffer since the given cursor', schema: { type: 'integer' } },
          },
        }),
        ...errors,
      },
    },
    logLevel: 'warn', // polled every few seconds
  }, async (req, reply) => {
    const q = req.query as { cursor?: string; limit?: number };
    const c = t.collect(q.cursor, q.limit ?? MAX_TRACE_SPANS, MAX_TRACE_BYTES);
    return reply
      .header('content-type', 'application/json')
      .header('cache-control', 'no-store')
      .header(TRACE_HEADERS.cursor, c.cursor)
      .header(TRACE_HEADERS.more, c.more ? '1' : '0')
      .header(TRACE_HEADERS.dropped, String(c.dropped))
      .send(JSON.stringify(c.body));
  });
}
