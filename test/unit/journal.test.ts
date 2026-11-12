import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../../src/errors.js';
import { DEFAULT_ENTRIES, MAX_ENTRIES, UnsupportedRange, journalctlArgs, outputFor, parseQuery, parseRange } from '../../src/journal.js';
import { logRoutes } from '../../src/routes/logs.js';
import { parseTraceparent, traceIdsOf } from '../../src/trace-context.js';

const CUR = 's=0123abcd;i=1f;b=89ab;m=2a;t=6b0c;x=77';

describe('outputFor (gatewayd Accept, exact match)', () => {
  it('maps the gatewayd mime types and falls back to text/plain', () => {
    expect(outputFor('application/vnd.fdo.journal')).toEqual({ mime: 'application/vnd.fdo.journal', mode: 'export' });
    expect(outputFor('application/json').mode).toBe('json');
    expect(outputFor('application/json-seq').mode).toBe('json-seq');
    expect(outputFor('text/event-stream').mode).toBe('json-sse');
    expect(outputFor(undefined)).toEqual({ mime: 'text/plain', mode: 'short' });
    // Like gatewayd: lists and parameters are not negotiated.
    expect(outputFor('application/json, text/plain').mode).toBe('short');
    expect(outputFor('toString').mode).toBe('short');
  });
});

describe('parseRange (gatewayd grammar)', () => {
  it('parses entries=', () => {
    expect(parseRange(undefined)).toEqual({ skip: 0 });
    expect(parseRange(`entries=${CUR}`)).toEqual({ skip: 0, cursor: CUR });
    expect(parseRange(`entries=${CUR}:1:50`)).toEqual({ skip: 1, cursor: CUR, entries: 50 });
    expect(parseRange(`entries=${CUR}:25`)).toEqual({ skip: 0, cursor: CUR, entries: 25 });
    expect(parseRange('entries=:10')).toEqual({ skip: 0, entries: 10 });
    expect(parseRange(`entries= ${CUR} junk:0:3`)).toEqual({ skip: 0, cursor: CUR, entries: 3 });
  });
  it('parses realtime=', () => {
    expect(parseRange('realtime=1700000000:')).toEqual({ skip: 0, since: '@1700000000' });
    expect(parseRange('realtime=:1700000000.5:0:5')).toEqual({ skip: 0, until: '@1700000000.5', entries: 5 });
    expect(parseRange('realtime=1:2:7')).toEqual({ skip: 0, since: '@1', until: '@2', entries: 7 });
  });
  it('ignores unknown range units, as gatewayd does', () => {
    expect(parseRange('bytes=0-10')).toEqual({ skip: 0 });
  });
  it('rejects malformed input (400)', () => {
    for (const h of ['entries=:0', 'entries=:x', 'entries=:1:2:3', 'entries=bad;cursor', 'entries=s=1;--x=2', 'realtime=5', 'realtime=x:', 'realtime=5:4', `entries=${'a'.repeat(5000)}`]) {
      expect(() => parseRange(h), h).toThrow(expect.objectContaining({ reason: 'invalid_request' }));
    }
  });
  it('refuses valid syntax outside the subset (416)', () => {
    for (const h of ['entries=:-10:10', 'entries=:1:10', `entries=${CUR}:2:10`, 'realtime=5min:', 'realtime=1:2:1:5']) {
      expect(() => parseRange(h), h).toThrow(UnsupportedRange);
    }
  });
});

describe('parseQuery', () => {
  it('takes boot and FIELD=value matches', () => {
    expect(parseQuery({})).toEqual({ boot: false, matches: [] });
    expect(parseQuery({ boot: '', _SYSTEMD_UNIT: ['a.service', 'b.service'], PRIORITY: '3' }))
      .toEqual({ boot: true, matches: ['_SYSTEMD_UNIT=a.service', '_SYSTEMD_UNIT=b.service', 'PRIORITY=3'] });
    expect(parseQuery({ boot: 'no', follow: 'false', discrete: '0' }).boot).toBe(false);
  });
  it('rejects option-like or invalid field names', () => {
    for (const k of ['--output', '-D', 'lower', '1ABC', 'A-B', 'A'.repeat(65), '+', '/usr/bin/x']) {
      expect(() => parseQuery({ [k]: 'v' }), k).toThrow(expect.objectContaining({ reason: 'invalid_request' }));
    }
    expect(() => parseQuery({ boot: 'maybe' })).toThrow(expect.objectContaining({ reason: 'invalid_request' }));
  });
  it('ignores the token credential and rejects NUL in values', () => {
    expect(parseQuery({ token: 'secret', PRIORITY: '3' })).toEqual({ boot: false, matches: ['PRIORITY=3'] });
    expect(() => parseQuery({ MESSAGE: 'a\0b' })).toThrow(expect.objectContaining({ reason: 'invalid_request' }));
  });
  it('refuses follow and discrete', () => {
    expect(() => parseQuery({ follow: '' })).toThrow(expect.objectContaining({ reason: 'feature_unsupported' }));
    expect(() => parseQuery({ discrete: 'yes' })).toThrow(expect.objectContaining({ reason: 'feature_unsupported' }));
  });
});

describe('journalctlArgs', () => {
  it('sets every option itself and puts matches after --', () => {
    expect(journalctlArgs('export', { skip: 1, cursor: CUR, entries: 50 }, { boot: true, matches: ['_SYSTEMD_UNIT=x.service'] }))
      .toEqual(['--no-pager', '--quiet', '--output=export', '--lines=+50', `--after-cursor=${CUR}`, '--boot', '--', '_SYSTEMD_UNIT=x.service']);
    expect(journalctlArgs('json', { skip: 0, cursor: CUR }, { boot: false, matches: [] }))
      .toEqual(['--no-pager', '--quiet', '--output=json', `--lines=+${DEFAULT_ENTRIES}`, `--cursor=${CUR}`, '--']);
    expect(journalctlArgs('short', { skip: 0, since: '@1', until: '@2', entries: 10 ** 9 }, { boot: false, matches: [] }))
      .toEqual(['--no-pager', '--quiet', '--output=short', `--lines=+${MAX_ENTRIES}`, '--since=@1', '--until=@2', '--']);
  });
});

describe('traceparent', () => {
  const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  it('parses valid W3C trace context and rejects the rest', () => {
    expect(parseTraceparent(tp)).toEqual({ trace_id: '0af7651916cd43dd8448eb211c80319c', span_id: 'b7ad6b7169203331' });
    expect(parseTraceparent('01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra')).not.toBeNull();
    for (const v of [undefined, '', 'garbage', `${tp}-extra`, 'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      '00-00000000000000000000000000000000-b7ad6b7169203331-01', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
      '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01']) {
      expect(parseTraceparent(v), String(v)).toBeNull();
    }
  });
  it('prefers _meta over the HTTP header', () => {
    const other = '00-11111111111111111111111111111111-2222222222222222-01';
    expect(traceIdsOf({ traceparent: tp }, { traceparent: other })?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(traceIdsOf(undefined, { traceparent: other })?.trace_id).toBe('11111111111111111111111111111111');
    expect(traceIdsOf({}, {})).toBeNull();
  });
});

describe('GET /api/v1/logs/entries (fake journalctl)', () => {
  let app: FastifyInstance;
  let dir: string;

  // Prints its arguments (one per line), fails on demand, or sleeps for the timeout test.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'journal-'));
    const bin = join(dir, 'journalctl');
    writeFileSync(bin, `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --cursor=s=dead*) echo "Failed to seek to cursor: Invalid argument" >&2; exit 1 ;;
    --since=@99) sleep 5 ;;
  esac
done
printf '%s\\n' "$@"
`);
    chmodSync(bin, 0o755);
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => { const e = toApiError(err); reply.code(e.status).send(e.toBody()); });
    await app.register(async (s) => logRoutes(s, { journalctl: bin, timeoutMs: 500 }));
  });
  afterAll(async () => { await app.close(); });

  it('streams journalctl output with the gatewayd content type', async () => {
    const r = await app.inject({
      url: '/api/v1/logs/entries?_SYSTEMD_UNIT=ozwell-computer.service&boot',
      headers: { accept: 'application/vnd.fdo.journal', range: `entries=${CUR}:1:20` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/vnd.fdo.journal');
    expect(r.body.trim().split('\n')).toEqual(['--no-pager', '--quiet', '--output=export', '--lines=+20', `--after-cursor=${CUR}`, '--boot', '--', '_SYSTEMD_UNIT=ozwell-computer.service']);
  });

  it('answers 400 for a cursor journalctl rejects, 416 outside the subset, 501 for follow', async () => {
    const seek = await app.inject({ url: '/api/v1/logs/entries', headers: { range: 'entries=s=dead' } });
    expect(seek.statusCode).toBe(400);
    expect(seek.json().error.message).toMatch(/Failed to seek/);
    expect((await app.inject({ url: '/api/v1/logs/entries', headers: { range: 'entries=:-5:5' } })).statusCode).toBe(416);
    expect((await app.inject({ url: '/api/v1/logs/entries', headers: { range: 'entries=:0' } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/v1/logs/entries?--output=cat' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/v1/logs/entries?follow' })).statusCode).toBe(501);
  });

  it('frees the reader slot when a request is rejected (NUL bytes)', async () => {
    // More than the 4-reader cap: none may leak.
    for (let i = 0; i < 6; i++) expect((await app.inject({ url: '/api/v1/logs/entries?MESSAGE=%00' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/v1/logs/entries?token=t' })).statusCode).toBe(200);
  });

  it('kills journalctl at the timeout', async () => {
    const t0 = Date.now();
    const r = await app.inject({ url: '/api/v1/logs/entries', headers: { range: 'realtime=99:' } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.statusCode).toBe(500);
  });
});
