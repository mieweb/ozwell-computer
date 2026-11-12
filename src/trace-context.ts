// W3C trace context (https://www.w3.org/TR/trace-context/) from the orchestrator, for log
// correlation only: request and MCP tool-call log lines carry its trace_id/span_id so they
// line up with the orchestrator's traces. The instance doesn't create spans itself.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

export interface TraceIds { trace_id: string; span_id: string }

/** trace_id/span_id from a traceparent, or null when absent or invalid. */
export function parseTraceparent(v: unknown): TraceIds | null {
  if (typeof v !== 'string' || v.length > 256) return null;
  const m = TRACEPARENT.exec(v.trim());
  if (!m) return null;
  const [, version, trace, span] = m;
  // Version ff is invalid; future versions may append fields (allowed by the regex's tail).
  if (version === 'ff' || (version === '00' && m[5])) return null;
  if (/^0+$/.test(trace) || /^0+$/.test(span)) return null;
  return { trace_id: trace, span_id: span };
}

/** From an MCP request's `params._meta.traceparent` first, else the HTTP header. */
export function traceIdsOf(meta: unknown, headers?: Record<string, unknown>): TraceIds | null {
  const fromMeta = meta && typeof meta === 'object' ? parseTraceparent((meta as Record<string, unknown>).traceparent) : null;
  return fromMeta ?? parseTraceparent(headers?.traceparent);
}
