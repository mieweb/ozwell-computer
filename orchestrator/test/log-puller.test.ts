// Phase 5: the instance log puller, against a fake instance serving the Journal Export
// Format and a fake VictoriaLogs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { LogPuller, exportField, readBounded, tagExport, JOURNAL_EXPORT } from '../src/log-puller.ts';
import { Metrics } from '../src/metrics.ts';
import type { Computer, Provider } from '../src/providers/types.ts';

const entry = (i: number) => `__CURSOR=s=1;i=${i.toString(16)}\n__REALTIME_TIMESTAMP=${1000 + i}\nMESSAGE=line ${i}\n\n`;

describe('tagExport', () => {
  it('tags every entry, finds the last cursor and drops a partial tail', () => {
    const extra = exportField('OZWELL_INSTANCE_ID', 'ozc-1');
    const len = Buffer.alloc(8); len.writeBigUInt64LE(3n);
    const binary = Buffer.concat([Buffer.from('__CURSOR=s=1;i=9\nDATA\n'), len, Buffer.from('a\nb'), Buffer.from('\n\n')]);
    const { body, entries, cursor } = tagExport(Buffer.concat([Buffer.from(entry(1)), binary, Buffer.from('__CURSOR=s=1;i=a\nMESS')]), extra);
    expect(entries).toBe(2);
    expect(cursor).toBe('s=1;i=9');
    expect(body.toString()).toBe(`${entry(1).slice(0, -1)}OZWELL_INSTANCE_ID=ozc-1\n\n${binary.subarray(0, -1).toString()}OZWELL_INSTANCE_ID=ozc-1\n\n`);
  });
  it('encodes values with newlines as binary fields', () => {
    const f = exportField('OZWELL_USER', 'a\nb');
    expect(f.subarray(0, 12).toString()).toBe('OZWELL_USER\n');
    expect(f.readBigUInt64LE(12)).toBe(3n);
    expect(f.subarray(20).toString()).toBe('a\nb\n');
  });
});

describe('LogPuller', () => {
  let inst: FastifyInstance, vl: FastifyInstance, instUrl: string, vlUrl: string;
  let journal: number[] = [];
  let requests: Array<{ range?: string; accept?: string }> = [];
  let shipped: string[] = [];
  let instStatus = 200, shipStatus = 204;

  beforeAll(async () => {
    inst = Fastify();
    inst.get('/api/v1/logs/entries', async (req, reply) => {
      requests.push({ range: req.headers.range, accept: req.headers.accept });
      if (req.headers.authorization !== 'Bearer t') return reply.code(401).send();
      if (instStatus !== 200) return reply.code(instStatus).send({ error: { reason: 'x', message: 'x' } });
      const range = req.headers.range ?? '';
      const n = Number(range.split(':').at(-1));
      let start = 0;
      const after = /^entries=s=1;i=([0-9a-f]+):1:/.exec(range);
      if (after) start = journal.indexOf(parseInt(after[1], 16)) + 1;
      else start = journal.findIndex((i) => 1000 + i >= Number(/^realtime=(\d+)/.exec(range)![1]));
      const out = start < 0 ? [] : journal.slice(start, start + n);
      return reply.type(JOURNAL_EXPORT).send(out.map(entry).join(''));
    });
    await inst.listen({ port: 0, host: '127.0.0.1' });
    instUrl = `http://127.0.0.1:${(inst.server.address() as any).port}`;

    vl = Fastify();
    vl.addContentTypeParser(JOURNAL_EXPORT, { parseAs: 'string' }, (_r, body, done) => done(null, body));
    vl.post('/insert/journald', async (req, reply) => {
      if (shipStatus !== 204) return reply.code(shipStatus).send();
      shipped.push(req.body as string);
      return reply.code(204).send();
    });
    await vl.listen({ port: 0, host: '127.0.0.1' });
    vlUrl = `http://127.0.0.1:${(vl.server.address() as any).port}/insert/journald`;
  });
  afterAll(async () => { await inst.close(); await vl.close(); });
  beforeEach(() => { journal = []; requests = []; shipped = []; instStatus = 200; shipStatus = 204; });

  function setup(computers: () => Computer[], batch = 1000) {
    let now = 1_000_000; // epoch ms: "now" is 1000 s, the realtime of entry 0
    const metrics = new Metrics({ defaultMetrics: false });
    const logs: Array<{ level: string; o: any; m: string }> = [];
    const provider: Provider = {
      scheme: 'memory', listAll: async () => computers(), list: async () => [], get: async () => null,
      create: async () => { throw new Error('no'); }, start: async () => { throw new Error('no'); }, destroy: async () => {},
    };
    const puller = new LogPuller({
      provider, shipUrl: vlUrl, metrics, batch, pollMs: 5000, discoverMs: 0, recheckMs: 600_000, now: () => now,
      log: { info: (o, m) => logs.push({ level: 'info', o, m }), warn: (o, m) => logs.push({ level: 'warn', o, m }) },
    });
    return { puller, metrics, logs, advance: (s: number) => { now += s * 1000; } };
  }
  const comp = (over: Partial<Computer> = {}): Computer => ({ id: 'ozc-1', owner: 'alice', status: 'running', stopped: false, internalUrl: instUrl, token: 't', ...over });
  const count = async (m: Metrics, outcome: string) => (await m.logPulls.get()).values.find((v) => v.labels.outcome === outcome)?.value ?? 0;

  it('starts at now, tags and ships entries, then continues after the last cursor', async () => {
    journal = [0, 1];
    const { puller, metrics, advance } = setup(() => [comp()]);
    await puller.tick();
    expect(requests[0]).toEqual({ range: 'realtime=1000::0:1000', accept: JOURNAL_EXPORT });
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toContain('MESSAGE=line 1\nOZWELL_INSTANCE_ID=ozc-1\nOZWELL_USER=alice\nOZWELL_PROVIDER=memory\n\n');

    await puller.tick(); // not due yet
    expect(requests).toHaveLength(1);
    journal.push(2);
    advance(5);
    await puller.tick();
    expect(requests[1].range).toBe('entries=s=1;i=1:1:1000');
    expect(shipped[1]).toContain('MESSAGE=line 2\n');
    expect(shipped[1]).not.toContain('line 1');
    expect((await metrics.logEntriesShipped.get()).values[0].value).toBe(3);
    expect(await count(metrics, 'ok')).toBe(2);
  });

  it('pulls again at once after a full batch', async () => {
    journal = [0, 1, 2];
    const { puller } = setup(() => [comp()], 2);
    await puller.tick();
    await puller.tick();
    expect(requests.map((r) => r.range)).toEqual(['realtime=1000::0:2', 'entries=s=1;i=1:1:2']);
    expect(shipped.join('')).toContain('line 2');
  });

  it('skips older instances (404), logs once, and re-checks after recheckMs', async () => {
    instStatus = 404;
    const { puller, metrics, logs, advance } = setup(() => [comp()]);
    await puller.tick();
    advance(60); await puller.tick();
    expect(requests).toHaveLength(1);
    expect((await metrics.logPullUnsupported.get()).values[0].value).toBe(1);
    expect(logs.filter((l) => /no logs route/.test(l.m))).toHaveLength(1);
    instStatus = 200; journal = [5];
    advance(600); await puller.tick();
    expect(requests).toHaveLength(2);
    expect(shipped).toHaveLength(1);
    expect((await metrics.logPullUnsupported.get()).values[0].value).toBe(0);
    expect(logs.at(-1)!.m).toMatch(/flowing again/);
    expect(await count(metrics, 'unsupported')).toBe(1);
  });

  it('backs off a refused token like an older instance, with a warning', async () => {
    const { puller, metrics, logs, advance } = setup(() => [comp({ token: 'wrong' })]);
    await puller.tick();
    advance(60); await puller.tick();
    expect(requests).toHaveLength(1);
    expect(await count(metrics, 'unauthorized')).toBe(1);
    expect(logs[0]).toMatchObject({ level: 'warn', o: { outcome: 'unauthorized' } });
  });

  it('keeps the cursor when VictoriaLogs refuses a batch, and backs off on errors', async () => {
    journal = [0];
    const { puller, metrics, advance } = setup(() => [comp()]);
    shipStatus = 503;
    await puller.tick();
    expect(await count(metrics, 'ship_error')).toBe(1);
    advance(5); await puller.tick();
    expect(requests).toHaveLength(1); // backoff: 10 s after one failure
    shipStatus = 204;
    advance(5); await puller.tick();
    expect(requests.map((r) => r.range)).toEqual(['realtime=1000::0:1000', 'realtime=1000::0:1000']);
    expect(shipped).toHaveLength(1);

    instStatus = 500;
    advance(5); await puller.tick();
    expect(await count(metrics, 'unavailable')).toBe(1);
  });

  it('serves the longest-waiting computers first, and does not wait for slow pulls', async () => {
    journal = [0];
    const many = ['a', 'b', 'c'].map((id) => comp({ id: `ozc-${id}` }));
    const { puller, advance } = setup(() => many);
    (puller as any).o.concurrency = 1;
    await puller.tick(); await puller.tick(); await puller.tick();
    expect(requests).toHaveLength(3); // one each, not the first one three times
    const states = (puller as any).states;
    expect(new Set([...states.values()].map((s: any) => s.cursor)).size).toBe(1);
    advance(5);
    // A pull that hangs doesn't block the next pass.
    (puller as any).o.concurrency = 8;
    let hang!: () => void;
    const orig = globalThis.fetch;
    let first = true;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
      if (first) { first = false; await new Promise<void>((r) => { hang = r; }); }
      return orig(...a);
    }) as typeof fetch;
    try {
      const slow = puller.tick();
      await new Promise((r) => setTimeout(r, 50));
      advance(5);
      const before = requests.length;
      await puller.tick(); // the first pass's pull is stuck: the others still get pulled
      expect(requests.length - before).toBe(2);
      hang(); await slow;
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('reads at most maxResponseBytes, ships the complete entries and continues at once', async () => {
    journal = [0, 1, 2, 3];
    const { puller } = setup(() => [comp()]);
    (puller as any).o.maxResponseBytes = entry(0).length + entry(1).length + 5; // two entries and a bit
    await puller.tick();
    expect(shipped[0]).toContain('line 1');
    expect(shipped[0]).not.toContain('line 2');
    await puller.tick(); // truncated: due again immediately
    expect(requests[1].range).toBe('entries=s=1;i=1:1:1000');
  });

  it('skips to now when one entry is larger than the whole budget', async () => {
    journal = [0];
    const { puller, metrics } = setup(() => [comp()]);
    (puller as any).o.maxResponseBytes = 10;
    await puller.tick();
    expect(shipped).toHaveLength(0);
    expect(await count(metrics, 'error')).toBe(1);
    expect(await readBounded(new Response('abcdef'), 3)).toEqual({ buf: Buffer.from('abc'), truncated: true });
  });

  it('keeps defaults for options passed as undefined', () => {
    const p = new LogPuller({ provider: {} as Provider, shipUrl: vlUrl, pollMs: undefined, batch: undefined });
    expect((p as any).o).toMatchObject({ pollMs: 5000, batch: 1000 });
  });

  it('drops stopped instances, and one failing instance does not hold up another', async () => {
    journal = [0];
    let list = [comp(), comp({ id: 'ozc-dead', internalUrl: 'http://127.0.0.1:1' })];
    const { puller, metrics, advance } = setup(() => list);
    await puller.tick();
    expect(shipped).toHaveLength(1);
    expect(await count(metrics, 'unavailable')).toBe(1);
    list = [comp({ stopped: true })];
    advance(5); await puller.tick();
    expect(requests).toHaveLength(1);
    expect((puller as any).states.size).toBe(0);
  });
});
