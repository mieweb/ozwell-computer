// GET /api/v1/logs/entries against the real journal, plus conformance with the real
// systemd-journal-gatewayd (downloaded into the container for this test only).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URL_, api, auth, exec, sleep, waitFor } from './helpers.js';

const TAG = `oz-logs-${randomBytes(4).toString('hex')}`;
const t0 = Math.floor(Date.now() / 1000) - 1;

/** Journal JSON entries (application/json is one object per line). */
async function entries(query: string, range?: string): Promise<any[]> {
  const r = await fetch(`${URL_}/api/v1/logs/entries${query}`, {
    headers: { ...auth, accept: 'application/json', ...(range ? { range } : {}) },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('application/json');
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(async () => {
  for (const i of [1, 2, 3]) {
    expect((await exec(`echo 'message ${i}' | systemd-cat -t ${TAG}`)).exit_code).toBe(0);
  }
  // journald is asynchronous.
  await waitFor(async () => (await entries(`?SYSLOG_IDENTIFIER=${TAG}`)).length === 3);
});

describe('logs entries', () => {
  it('returns matching entries oldest first, in the journal JSON format', async () => {
    const got = await entries(`?SYSLOG_IDENTIFIER=${TAG}&boot`);
    expect(got.map((e) => e.MESSAGE)).toEqual(['message 1', 'message 2', 'message 3']);
    expect(got[0].__CURSOR).toMatch(/^s=/);
  });

  it('reads the system journal (systemd-journal group), not only the user journal', async () => {
    // Root's messages go to the system journal, which desktop can only read through the group.
    expect((await exec(`echo 'as root' | sudo systemd-cat -t ${TAG}-root`)).exit_code).toBe(0);
    const got = await waitFor(async () => {
      const e = await entries(`?SYSLOG_IDENTIFIER=${TAG}-root`);
      return e.length ? e : null;
    });
    expect(got[0]).toMatchObject({ MESSAGE: 'as root', _UID: '0' });
  });

  it('pages with a cursor (skip 1 starts after it) and bounds by realtime', async () => {
    const [first] = await entries(`?SYSLOG_IDENTIFIER=${TAG}`, 'entries=:1');
    expect(first.MESSAGE).toBe('message 1');
    const after = await entries(`?SYSLOG_IDENTIFIER=${TAG}`, `entries=${first.__CURSOR}:1:10`);
    expect(after.map((e) => e.MESSAGE)).toEqual(['message 2', 'message 3']);
    const at = await entries(`?SYSLOG_IDENTIFIER=${TAG}`, `entries=${first.__CURSOR}:0:2`);
    expect(at.map((e) => e.MESSAGE)).toEqual(['message 1', 'message 2']);
    expect((await entries(`?SYSLOG_IDENTIFIER=${TAG}`, `realtime=${t0}:`)).length).toBe(3);
    expect(await entries(`?SYSLOG_IDENTIFIER=${TAG}`, `realtime=:${t0 - 3600}`)).toEqual([]);
  });

  it('serves the Journal Export Format', async () => {
    const r = await api('GET', `/api/v1/logs/entries?SYSLOG_IDENTIFIER=${TAG}`, undefined, { accept: 'application/vnd.fdo.journal' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/vnd.fdo.journal');
    const text = (r.body as Buffer).toString();
    expect(text).toContain('MESSAGE=message 2\n');
    expect(text.match(/^__CURSOR=/gm)).toHaveLength(3);
  });

  it('refuses what it does not support', async () => {
    expect((await api('GET', '/api/v1/logs/entries', undefined, { range: 'entries=:-5:5' })).status).toBe(416);
    expect((await api('GET', '/api/v1/logs/entries?--output=cat')).status).toBe(400);
    expect((await api('GET', '/api/v1/logs/entries', undefined, { range: 'entries=s=0;i=0' })).status).toBe(400);
    expect((await api('GET', '/api/v1/logs/entries?follow')).status).toBe(501);
    expect((await fetch(`${URL_}/api/v1/logs/entries`)).status).toBe(401);
  });
});

describe('trace correlation', () => {
  const trace = randomBytes(16).toString('hex');
  const parent = (span: string) => `00-${trace}-${span}-01`;

  it('puts trace_id/span_id from traceparent (header or MCP _meta) on log lines', async () => {
    await api('GET', '/api/v1/windows', undefined, { traceparent: parent('1111111111111111') });

    const client = new Client({ name: 'oz-logs-trace', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: auth } });
    await client.connect(transport);
    try {
      await client.callTool({ name: 'list_windows', arguments: {}, _meta: { traceparent: parent('2222222222222222') } });
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }

    const lines = await waitFor(async () => {
      const got = (await entries('?_SYSTEMD_UNIT=ozwell-computer.service', `realtime=${t0}:`))
        .map((e) => { try { return JSON.parse(e.MESSAGE); } catch { return null; } })
        .filter((l) => l?.trace_id === trace);
      return got.some((l) => l.msg === 'mcp tool call') && got.some((l) => l.msg === 'incoming request') ? got : null;
    });
    expect(lines.find((l) => l.msg === 'incoming request').span_id).toBe('1111111111111111');
    expect(lines.find((l) => l.msg === 'mcp tool call')).toMatchObject({ tool: 'list_windows', span_id: '2222222222222222' });
  });
});

/**
 * The route is a subset of systemd-journal-gatewayd's /entries: for requests inside the
 * subset, it must answer exactly as the real gatewayd does. gatewayd isn't shipped (its
 * package would upgrade systemd); it is downloaded and run from /tmp for this test only,
 * with its own libsystemd-shared. Skipped, with a message, when the download fails.
 */
describe('gatewayd conformance', () => {
  const GW = '127.0.0.1:19531';
  let ready = false;

  beforeAll(async () => {
    const setup = (await api('POST', '/api/v1/exec', { timeout_ms: 110_000, cmd: [
      'set -e; d=/tmp/oz-gatewayd; rm -rf $d; mkdir -p $d; cd $d',
      // One unreachable source (e.g. the release index before a release) mustn't stop it.
      '{ sudo apt-get update -qq >/dev/null 2>&1 || true; }',
      'apt-get download -qq systemd-journal-remote libsystemd-shared libmicrohttpd12t64 >/dev/null 2>&1',
      'for f in *.deb; do dpkg-deb -x $f root; done',
      'lib=$(dirname $(find $d/root -name "libsystemd-shared-*.so" | head -1)):$(dirname $(find $d/root -name "libmicrohttpd.so.*" | head -1))',
      // As root, which reads the same journals as the server's systemd-journal group.
      // systemd-socket-activate starts it with a clean environment: pass the libraries with -E.
      `sudo -b systemd-socket-activate -l ${GW} -E LD_LIBRARY_PATH=$lib $d/root/usr/lib/systemd/systemd-journal-gatewayd >$d/log 2>&1`,
      'echo ok',
    ].join(' && ') })).body as { exit_code: number; stdout: string; stderr?: string };
    if (setup.exit_code !== 0) console.warn(`gatewayd conformance skipped: could not set up gatewayd (${setup.stderr ?? setup.stdout})`);
    if (setup.exit_code !== 0) return;
    ready = await waitFor(async () => (await exec(`curl -sf -o /dev/null http://${GW}/machine && echo up`)).stdout.includes('up'), 15000)
      .then(() => true, () => false);
  }, 120_000);
  afterAll(async () => { await exec('sudo pkill -f systemd-journal-gatewayd; sudo pkill -f "systemd-socket-activate -l 127.0.0.1:19531"'); });

  const both = async (query: string, headers: Record<string, string>) => {
    const h = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
    const ref = await exec(`curl -s -o /tmp/oz-gatewayd/body -w '%{http_code}' ${h} 'http://${GW}/entries${query}'; echo; base64 -w0 /tmp/oz-gatewayd/body`);
    const [status, b64] = ref.stdout.split('\n');
    const ours = await fetch(`${URL_}/api/v1/logs/entries${query}`, { headers: { ...auth, ...headers } });
    return { gateway: { status: Number(status), body: Buffer.from(b64 ?? '', 'base64').toString() }, ours: { status: ours.status, body: await ours.text() } };
  };

  /**
   * journald's JSON key order comes from a per-process hash seed, so it differs between any
   * two runs (journalctl or gatewayd alike): JSON formats are compared parsed. The export
   * and text formats are deterministic and compared byte for byte.
   */
  const normalise = (accept: string, body: string): unknown => {
    switch (accept) {
      case 'application/json': return body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      case 'application/json-seq': return body.split('\x1e').filter(Boolean).map((r) => JSON.parse(r));
      case 'text/event-stream': return body.split('\n\n').filter(Boolean).map((r) => JSON.parse(r.replace(/^data: /, '')));
      default: return body;
    }
  };

  it('matches the real gatewayd inside the subset', async (ctx) => {
    if (!ready) ctx.skip();
    const [first] = await entries(`?SYSLOG_IDENTIFIER=${TAG}`, 'entries=:1');
    const cases: Array<[string, Record<string, string>]> = [];
    for (const accept of ['application/vnd.fdo.journal', 'application/json', 'application/json-seq', 'text/event-stream', 'text/plain']) {
      cases.push([`?SYSLOG_IDENTIFIER=${TAG}`, { accept }]);
    }
    cases.push(
      [`?SYSLOG_IDENTIFIER=${TAG}`, { accept: 'application/json', range: `entries=${first.__CURSOR}:1:10` }],
      [`?SYSLOG_IDENTIFIER=${TAG}`, { accept: 'application/json', range: `entries=${first.__CURSOR}:0:2` }],
      [`?SYSLOG_IDENTIFIER=${TAG}`, { accept: 'application/json', range: 'entries=:2' }],
      [`?SYSLOG_IDENTIFIER=${TAG}&boot`, { accept: 'application/json', range: `realtime=${t0}:` }],
      [`?SYSLOG_IDENTIFIER=${TAG}&SYSLOG_IDENTIFIER=nope`, { accept: 'application/json' }],
      [`?SYSLOG_IDENTIFIER=${TAG}`, { accept: 'application/json, text/plain' }],
    );
    for (const [query, headers] of cases) {
      const r = await both(query, headers);
      expect(r.ours.status, `${query} ${JSON.stringify(headers)}`).toBe(r.gateway.status);
      const what = `${query} ${JSON.stringify(headers)}`;
      if (r.gateway.status === 200) expect(r.gateway.body.length, `${what}: gatewayd returned nothing`).toBeGreaterThan(0);
      expect(normalise(headers.accept, r.ours.body), what).toEqual(normalise(headers.accept, r.gateway.body));
    }
  }, 60_000);

  it('rejects malformed requests as gatewayd does', async (ctx) => {
    if (!ready) ctx.skip();
    for (const range of ['entries=:0', 'entries=:x', 'realtime=5', 'realtime=5:4']) {
      const r = await both('', { range });
      expect(r.gateway.status, range).toBe(400);
      expect(r.ours.status, range).toBe(400);
    }
    await sleep(0);
  });
});
