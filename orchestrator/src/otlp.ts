// OTLP/JSON → OTLP/protobuf for ExportTraceServiceRequest (opentelemetry-proto
// trace/v1 and common/v1), for spans pulled from computers (log-puller.ts).
//
// Computers serve OTLP JSON; this re-encodes it as protobuf, which every OTLP/HTTP receiver
// accepts (VictoriaTraces' /insert/opentelemetry/v1/traces included). Only known fields are
// copied, so the agent-controlled input can't smuggle anything else through, and resource
// attributes can be added (ozwell.instance_id, ...) on the way.

type Json = Record<string, unknown>;

/** Most elements (spans, events, links, attributes, values) one request may hold. */
export const MAX_ELEMENTS = 200_000;

/**
 * Counts encoded elements, so a response within the byte cap can't still cost far more
 * memory to encode (millions of tiny events, each a Writer and a few Buffers).
 */
let budget = 0;
const spend = () => { if (--budget < 0) throw new Error(`more than ${MAX_ELEMENTS} elements`); };

class Writer {
  private parts: Buffer[] = [];
  private len = 0;
  private push(b: Buffer) { this.parts.push(b); this.len += b.length; }
  private varint(n: bigint) {
    const out: number[] = [];
    let v = BigInt.asUintN(64, n);
    while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
    out.push(Number(v));
    this.push(Buffer.from(out));
  }
  private tag(field: number, wire: number) { this.varint(BigInt((field << 3) | wire)); }
  uint(field: number, v: number | bigint | undefined) {
    if (v === undefined || v === 0 || v === 0n) return;
    this.tag(field, 0); this.varint(BigInt(v));
  }
  bool(field: number, v: boolean) { this.tag(field, 0); this.varint(v ? 1n : 0n); }
  fixed64(field: number, v: bigint | undefined) {
    if (!v) return;
    const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, v));
    this.tag(field, 1); this.push(b);
  }
  fixed32(field: number, v: number | undefined) {
    if (!v) return;
    const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0);
    this.tag(field, 5); this.push(b);
  }
  double(field: number, v: number) {
    const b = Buffer.alloc(8); b.writeDoubleLE(v);
    this.tag(field, 1); this.push(b);
  }
  /** `always`: write the field even when empty (a set oneof member). */
  bytes(field: number, v: Buffer | undefined, always = false) {
    if (!v || (v.length === 0 && !always)) return;
    this.tag(field, 2); this.varint(BigInt(v.length)); this.push(v);
  }
  string(field: number, v: unknown) { if (typeof v === 'string' && v) this.bytes(field, Buffer.from(v)); }
  message(field: number, fn: (w: Writer) => void) {
    spend();
    const w = new Writer(); fn(w);
    this.tag(field, 2); this.varint(BigInt(w.len)); this.push(w.finish());
  }
  finish() { return Buffer.concat(this.parts, this.len); }
}

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object') : []);
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function int64(v: unknown): bigint | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d{1,20}$/.test(v)) { try { return BigInt(v); } catch { return undefined; } }
  return undefined;
}

/** A hex id of exactly `bytes` bytes (OTLP JSON encodes trace/span ids as hex). */
function hexId(v: unknown, bytes: number): Buffer | undefined {
  return typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(v) ? Buffer.from(v, 'hex') : undefined;
}

function anyValue(w: Writer, v: Json, depth: number) {
  // Empty strings and bytes are set oneof variants: keep their (zero-length) fields.
  if (typeof v.stringValue === 'string') w.bytes(1, Buffer.from(v.stringValue), true);
  else if (typeof v.boolValue === 'boolean') w.bool(2, v.boolValue);
  else if (int64(v.intValue) !== undefined) { const n = int64(v.intValue)!; if (n !== 0n) w.uint(3, n); else w.bool(3, false); }
  else if (num(v.doubleValue) !== undefined) w.double(4, num(v.doubleValue)!);
  else if (depth < 4 && obj(v.arrayValue)) w.message(5, (a) => { for (const x of arr(obj(v.arrayValue)!.values)) a.message(1, (m) => anyValue(m, x, depth + 1)); });
  else if (depth < 4 && obj(v.kvlistValue)) w.message(6, (a) => keyValues(a, 1, obj(v.kvlistValue)!.values, depth + 1));
  else if (typeof v.bytesValue === 'string') w.bytes(7, Buffer.from(v.bytesValue, 'base64'), true);
}

function keyValues(w: Writer, field: number, list: unknown, depth = 0) {
  for (const kv of arr(list)) {
    if (typeof kv.key !== 'string') continue;
    w.message(field, (m) => {
      m.string(1, kv.key);
      const v = obj(kv.value);
      if (v) m.message(2, (a) => anyValue(a, v, depth));
    });
  }
}

function span(w: Writer, s: Json) {
  w.bytes(1, hexId(s.traceId, 16));
  w.bytes(2, hexId(s.spanId, 8));
  w.string(3, s.traceState);
  w.bytes(4, hexId(s.parentSpanId, 8));
  w.string(5, s.name);
  w.uint(6, num(s.kind));
  w.fixed64(7, int64(s.startTimeUnixNano));
  w.fixed64(8, int64(s.endTimeUnixNano));
  keyValues(w, 9, s.attributes);
  w.uint(10, num(s.droppedAttributesCount));
  for (const e of arr(s.events)) {
    w.message(11, (m) => {
      m.fixed64(1, int64(e.timeUnixNano));
      m.string(2, e.name);
      keyValues(m, 3, e.attributes);
      m.uint(4, num(e.droppedAttributesCount));
    });
  }
  w.uint(12, num(s.droppedEventsCount));
  for (const l of arr(s.links)) {
    w.message(13, (m) => {
      m.bytes(1, hexId(l.traceId, 16));
      m.bytes(2, hexId(l.spanId, 8));
      m.string(3, l.traceState);
      keyValues(m, 4, l.attributes);
      m.uint(5, num(l.droppedAttributesCount));
      m.fixed32(6, num(l.flags));
    });
  }
  w.uint(14, num(s.droppedLinksCount));
  const st = obj(s.status);
  if (st && (st.message || st.code)) w.message(15, (m) => { m.string(2, st.message); m.uint(3, num(st.code)); });
  w.fixed32(16, num(s.flags));
}

export interface Converted { body: Buffer; spans: number }

/**
 * Encode an OTLP JSON ExportTraceServiceRequest as protobuf, adding `resource` attributes
 * to every resource (replacing same-named ones). Spans without valid trace/span ids are dropped.
 * Throws past `maxElements` nested messages (spans, events, links, attributes, values).
 */
export function otlpJsonToProto(req: unknown, resource: Record<string, string>, maxElements = MAX_ELEMENTS): Converted {
  budget = maxElements;
  const w = new Writer();
  let spans = 0;
  for (const rs of arr(obj(req)?.resourceSpans)) {
    const scopes = arr(rs.scopeSpans).map((ss) => ({ ss, spans: arr(ss.spans).filter((s) => hexId(s.traceId, 16) && hexId(s.spanId, 8)) }))
      .filter((x) => x.spans.length);
    if (!scopes.length) continue;
    w.message(1, (r) => {
      r.message(1, (res) => {
        const own = arr(obj(rs.resource)?.attributes).filter((kv) => typeof kv.key !== 'string' || !(kv.key in resource));
        keyValues(res, 1, [...own, ...Object.entries(resource).map(([key, v]) => ({ key, value: { stringValue: v } }))]);
      });
      for (const { ss, spans: list } of scopes) {
        r.message(2, (sm) => {
          const scope = obj(ss.scope);
          if (scope) sm.message(1, (m) => { m.string(1, scope.name); m.string(2, scope.version); keyValues(m, 3, scope.attributes); });
          for (const s of list) { sm.message(2, (m) => span(m, s)); spans++; }
          sm.string(3, ss.schemaUrl);
        });
      }
      r.string(3, rs.schemaUrl);
    });
  }
  return { body: w.finish(), spans };
}
