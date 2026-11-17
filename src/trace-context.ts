// W3C trace context (https://www.w3.org/TR/trace-context/) from the orchestrator: request
// and MCP tool-call log lines carry its trace_id/span_id, and the instance's spans
// (src/tracing.ts) continue it.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

export interface TraceIds { trace_id: string; span_id: string }

/**
 * trace_id/span_id from a traceparent, or null when absent or invalid. A header sent more
 * than once arrives combined ("a, b") or as an array: the first valid value wins, rather
 * than losing the context.
 */
export function parseTraceparent(v: unknown): TraceIds | null {
  const c = parseContext(v);
  return c && { trace_id: c.trace_id, span_id: c.span_id };
}

/** parseTraceparent plus the sampled flag (trace-flags bit 0). */
export function parseContext(v: unknown): (TraceIds & { sampled: boolean }) | null {
  if (Array.isArray(v)) v = v.join(',');
  if (typeof v === 'string' && v.includes(',')) {
    if (v.length > 2048) return null;
    for (const part of v.split(',').slice(0, 8)) {
      const ids = parseOne(part);
      if (ids) return ids;
    }
    return null;
  }
  return parseOne(v);
}

function parseOne(v: unknown): (TraceIds & { sampled: boolean }) | null {
  if (typeof v !== 'string' || v.length > 256) return null;
  const m = TRACEPARENT.exec(v.trim());
  if (!m) return null;
  const [, version, trace, span, flags] = m;
  // Version ff is invalid; future versions may append fields (allowed by the regex's tail).
  if (version === 'ff' || (version === '00' && m[5])) return null;
  if (/^0+$/.test(trace) || /^0+$/.test(span)) return null;
  return { trace_id: trace, span_id: span, sampled: (parseInt(flags, 16) & 1) === 1 };
}

/** From an MCP request's `params._meta.traceparent` first, else the HTTP header. */
export function traceIdsOf(meta: unknown, headers?: Record<string, unknown>): TraceIds | null {
  const fromMeta = meta && typeof meta === 'object' ? parseTraceparent((meta as Record<string, unknown>).traceparent) : null;
  return fromMeta ?? parseTraceparent(headers?.traceparent);
}
