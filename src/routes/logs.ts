// GET /api/v1/logs/entries: the journal, in systemd-journal-gatewayd's /entries API (a
// subset; see src/journal.ts). The orchestrator pulls it into VictoriaLogs.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, unsupported } from '../errors.js';
import { DEFAULT_ENTRIES, MAX_ENTRIES, OUTPUT_MODES, UnsupportedRange, journalctlArgs, outputFor, parseQuery, parseRange } from '../journal.js';
import { errors, media } from './schemas.js';

/** journalctl runs at once per server; more get 429. */
const MAX_CONCURRENT = 4;
/** Wall-clock limit for one request (journalctl is killed after it). */
const TIMEOUT_MS = 30_000;

export interface LogRoutesOptions {
  /** The journalctl binary (tests). */
  journalctl?: string;
  timeoutMs?: number;
}

export async function logRoutes(app: FastifyInstance, opts: LogRoutesOptions = {}) {
  const bin = opts.journalctl ?? 'journalctl';
  let running = 0;

  app.get('/api/v1/logs/entries', {
    schema: {
      tags: ['system'],
      summary: 'Journal entries (systemd-journal-gatewayd compatible)',
      description:
        'A subset of systemd-journal-gatewayd\'s /entries API, served by journalctl. ' +
        'Accept picks the format by exact match, as in gatewayd: application/vnd.fdo.journal (Journal Export Format), ' +
        'application/json, application/json-seq, text/event-stream, else text/plain. ' +
        'Range: entries=[cursor][[:skip]:n] (skip 0, or 1 after a cursor, to start after it) or ' +
        'realtime=[since]:[until][[:0]:n] (seconds since the epoch). Without a Range, entries start at the head of the journal. ' +
        `At most ${MAX_ENTRIES} entries per response (${DEFAULT_ENTRIES} when the Range names none): page with the last __CURSOR. ` +
        'Query: boot (current boot only) and FIELD=value journal matches (the same field ORs, different fields AND). ' +
        'follow and discrete are not supported. Valid Range syntax outside the subset gets 416.',
      querystring: { type: 'object', additionalProperties: true, properties: {
        boot: { type: 'string', description: 'Only the current boot (empty or a boolean)' },
      } },
      headers: { type: 'object', properties: {
        range: { type: 'string', description: 'entries=… or realtime=…, as in systemd-journal-gatewayd' },
        accept: { type: 'string', description: 'Output format (exact match)' },
      } },
      response: {
        200: media('Journal entries in the requested format', Object.keys(OUTPUT_MODES), { type: 'string' }),
        ...errors,
      },
    },
    logLevel: 'warn', // polled every few seconds
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    let args: string[];
    const { mime, mode } = outputFor(req.headers.accept);
    try {
      args = journalctlArgs(mode, parseRange(req.headers.range), parseQuery(req.query as Record<string, unknown>));
    } catch (e) {
      if (e instanceof UnsupportedRange) return reply.code(416).send(new ApiError('invalid_request', e.message).toBody());
      throw e;
    }
    if (running >= MAX_CONCURRENT) throw new ApiError('rate_limited', 'too many journal reads at once', { retryAfterMs: 1000 });
    // Counts journalctl processes, which can outlive this handler while they stream.
    running++;
    return stream(reply, bin, args, mime, opts.timeoutMs ?? TIMEOUT_MS, () => { running--; });
  });
}

/**
 * Run journalctl and stream its stdout. The status is held until the first output (or
 * exit), so a failure before any output (e.g. a cursor journalctl rejects) is a 400 like
 * gatewayd's, not a 200 with an empty body.
 */
function stream(reply: FastifyReply, bin: string, args: string[], mime: string, timeoutMs: number, exited: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let gone = false;
    const release = () => { if (!gone) { gone = true; exited(); } };
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a kill also reaches anything it started.
        detached: true,
        env: { ...process.env, SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', SYSTEMD_LESS: '' },
      });
    } catch (e) {
      // Bad arguments make spawn throw before any handler is attached: free the slot.
      release();
      reject(e);
      return;
    }
    let stderr = '';
    let started = false;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(reply); } };
    const kill = () => {
      if (gone || child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    };
    const timer = setTimeout(kill, timeoutMs);
    timer.unref();
    // The client went away: stop reading the journal.
    reply.raw.once('close', kill);
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4096) stderr += d; });

    const out = new PassThrough();
    const start = () => {
      if (started) return;
      started = true;
      reply.code(200).header('content-type', mime).header('cache-control', 'no-store');
      done();
      reply.send(out);
    };
    child.stdout.once('data', start);
    child.stdout.pipe(out);

    child.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      release();
      if (started) { out.destroy(e); return; }
      settled = true;
      reject(e.code === 'ENOENT'
        ? unsupported('journal', 'journalctl is not installed')
        : e);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      release();
      reply.raw.off('close', kill);
      if (started || settled) return;
      if (code === 0) { start(); return; }
      settled = true;
      const msg = stderr.trim().split('\n').at(-1) || `journalctl exited with ${code ?? signal}`;
      // journalctl rejects requests it can't seek (a cursor from another journal, ...): gatewayd's 400.
      reply.code(signal ? 500 : 400).send(new ApiError(signal ? 'internal' : 'invalid_request', msg).toBody());
      resolve(reply);
    });
  });
}
