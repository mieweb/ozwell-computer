// GET /api/v1/logs/entries: a subset of systemd-journal-gatewayd's /entries API
// (man systemd-journal-gatewayd.service), served by running journalctl. The formats are
// journalctl's own output, the same serialiser gatewayd uses. Semantics follow gatewayd's
// source (src/journal-remote/journal-gatewayd.c); anything outside the subset is refused
// rather than approximated. See docs/observability-plan.md, workstream 3.
import { ApiError, unsupported } from './errors.js';

/** gatewayd's Accept → journalctl -o, by exact header match (as gatewayd does); else short. */
export const OUTPUT_MODES = {
  'text/plain': 'short',
  'application/json': 'json',
  'text/event-stream': 'json-sse',
  'application/json-seq': 'json-seq',
  'application/vnd.fdo.journal': 'export',
} as const;
export type MimeType = keyof typeof OUTPUT_MODES;

export function outputFor(accept: string | undefined): { mime: MimeType; mode: string } {
  const mime = (accept && Object.hasOwn(OUTPUT_MODES, accept) ? accept : 'text/plain') as MimeType;
  return { mime, mode: OUTPUT_MODES[mime] };
}

/** Entries per response: the default when the request names none, and the cap. */
export const DEFAULT_ENTRIES = 1000;
export const MAX_ENTRIES = 5000;

export interface JournalRange {
  cursor?: string;
  /** Entries to skip from the start position. Only 0, or 1 after a cursor, are supported. */
  skip: number;
  entries?: number;
  /** Realtime bounds, as journalctl `@<seconds>` strings. */
  since?: string;
  until?: string;
}

const bad = (m: string) => new ApiError('invalid_request', m);
/** Valid gatewayd syntax we don't implement: 416, with the reason. */
export class UnsupportedRange extends Error {}

// A journal cursor: `s=<hex>;i=<hex>;b=<hex>;m=<hex>;t=<hex>;x=<hex>` (fields may vary).
const CURSOR = /^[a-z]=[0-9a-f]{1,64}(;[a-z]=[0-9a-f]{1,64}){0,15}$/;
// gatewayd uses parse_sec(), which also takes units ("5min"); we take plain seconds.
const SECONDS = /^\d{1,12}(\.\d{1,6})?$/;
const UNIT_SECONDS = /^\d+(\.\d+)?\s*[a-zµ]+$/i;

function skipAndEntries(s: string, r: JournalRange) {
  // After the first colon: `[skip:]entries`.
  const parts = s.split(':');
  if (parts.length > 2) throw bad('malformed Range header');
  const [skip, entries] = parts.length === 2 ? parts : [undefined, parts[0]];
  if (skip !== undefined && skip !== '') {
    if (!/^[+-]?\d{1,18}$/.test(skip)) throw bad('malformed Range header: skip');
    r.skip = Number(skip);
  }
  if (!/^\+?\d{1,18}$/.test(entries ?? '') || Number(entries) <= 0) throw bad('malformed Range header: entries must be a positive integer');
  r.entries = Number(entries);
}

function seconds(s: string, what: string): string {
  if (SECONDS.test(s)) return `@${s}`;
  if (UNIT_SECONDS.test(s)) throw new UnsupportedRange(`${what} with a time unit is not supported; give seconds since the epoch`);
  throw bad(`malformed Range header: ${what}`);
}

/** Parse gatewayd's Range header. Unknown range units are ignored, as gatewayd does. */
export function parseRange(header: string | undefined): JournalRange {
  const r: JournalRange = { skip: 0 };
  if (!header) return r;
  if (header.length > 4096) throw bad('Range header too long');
  if (header.startsWith('entries=')) {
    const rest = header.slice('entries='.length).trimStart();
    const colon = rest.indexOf(':');
    // gatewayd ends the cursor at the first whitespace.
    const cursor = (colon < 0 ? rest : rest.slice(0, colon)).split(/\s/)[0];
    if (colon >= 0) skipAndEntries(rest.slice(colon + 1), r);
    if (cursor) {
      if (!CURSOR.test(cursor)) throw bad('malformed cursor');
      r.cursor = cursor;
    }
  } else if (header.startsWith('realtime=')) {
    const rest = header.slice('realtime='.length).trimStart();
    const colon = rest.indexOf(':');
    if (colon < 0) throw bad('malformed Range header: realtime needs since:until');
    if (colon > 0) r.since = seconds(rest.slice(0, colon), 'since');
    const tail = rest.slice(colon + 1);
    const colon2 = tail.indexOf(':');
    const until = colon2 < 0 ? tail : tail.slice(0, colon2);
    if (colon2 >= 0) skipAndEntries(tail.slice(colon2 + 1), r);
    if (until) {
      r.until = seconds(until, 'until');
      if (r.since && Number(r.until.slice(1)) < Number(r.since.slice(1))) throw bad('malformed Range header: until is before since');
    }
  } else {
    return r;
  }
  // Skips: gatewayd applies them to the first entry read. Map those journalctl can express.
  if (r.skip < 0) throw new UnsupportedRange('negative skip is not supported');
  if (r.skip > 1 || (r.skip === 1 && !r.cursor)) throw new UnsupportedRange('skip is only supported as 1 after a cursor');
  return r;
}

const FIELD = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** gatewayd's boolean parser (parse_boolean). */
function bool(v: string): boolean {
  if (['', '1', 'yes', 'y', 'true', 't', 'on'].includes(v.toLowerCase())) return true;
  if (['0', 'no', 'n', 'false', 'f', 'off'].includes(v.toLowerCase())) return false;
  throw bad(`malformed boolean ${JSON.stringify(v)}`);
}

export interface JournalQuery { boot: boolean; matches: string[] }

/** Query parameters: `boot`, `follow`/`discrete` (only when false), and FIELD=value matches. */
export function parseQuery(q: Record<string, unknown>): JournalQuery {
  const out: JournalQuery = { boot: false, matches: [] };
  for (const [key, raw] of Object.entries(q)) {
    const values = (Array.isArray(raw) ? raw : [raw]).map((v) => (v === undefined || v === null ? '' : String(v)));
    if (key === '') throw bad('empty query parameter name');
    if (key === 'boot') { out.boot = values.map(bool).at(-1)!; continue; }
    if (key === 'follow' || key === 'discrete') {
      if (values.map(bool).at(-1)) throw unsupported(`journal_${key}`, `${key} is not supported`);
      continue;
    }
    if (!FIELD.test(key)) throw bad(`invalid journal field name ${JSON.stringify(key)}`);
    for (const v of values) out.matches.push(`${key}=${v}`);
  }
  return out;
}

/**
 * journalctl arguments for a request. Every option is set here; caller-supplied text only
 * appears inside `--cursor=`/`--after-cursor=`/`--since=`/`--until=` (validated above)
 * and as FIELD=value matches after `--`, so it can never become an option.
 */
export function journalctlArgs(mode: string, range: JournalRange, query: JournalQuery): string[] {
  const n = Math.min(range.entries ?? DEFAULT_ENTRIES, MAX_ENTRIES);
  const args = ['--no-pager', '--quiet', `--output=${mode}`, `--lines=+${n}`];
  if (range.cursor) args.push(range.skip === 1 ? `--after-cursor=${range.cursor}` : `--cursor=${range.cursor}`);
  else if (range.since) args.push(`--since=${range.since}`);
  if (range.until) args.push(`--until=${range.until}`);
  if (query.boot) args.push('--boot');
  args.push('--', ...query.matches);
  return args;
}
