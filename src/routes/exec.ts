import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { AppContext } from '../server.js';
import { runCommand, type ExecRequest } from '../process/exec.js';
import { MAX_WAIT_MS, jobsFor, summarize, type JobOffsets, type JobView } from '../process/jobs.js';
import { loadPty } from '../process/pty.js';
import { parseRange, safePath, signedUrl, verifySignature, type SignMethod } from '../fs/index.js';
import { deriveKey, generateToken } from '../auth/token.js';
import { errors, execResult, fsPath, fsStat, jobSummary, jobView, media, ok, prop, record, upload } from './schemas.js';
import { eventStreams, openSse } from './sse.js';

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

export async function statEntry(path: string) {
  const st = await lstat(path);
  const type = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other';
  return { path, type, size: st.size, mode: (st.mode & 0o7777).toString(8), mtime: st.mtime.toISOString() };
}

export async function sendFile(req: FastifyRequest, reply: FastifyReply, path: string) {
  let st;
  try { st = await stat(path); } catch (e) { throw (e as any).code === 'ENOENT' ? new ApiError('path_not_found', `no such file: ${path}`) : e; }
  if (!st.isFile()) throw new ApiError('invalid_request', 'not a regular file');
  const range = parseRange(req.headers.range, st.size);
  reply.header('accept-ranges', 'bytes').header('content-type', 'application/octet-stream').header('last-modified', st.mtime.toUTCString());
  if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${st.size}`).send(new ApiError('invalid_request', 'range not satisfiable').toBody());
  if (range) {
    reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${st.size}`).header('content-length', range.end - range.start + 1);
    return reply.send(createReadStream(path, { start: range.start, end: range.end }));
  }
  reply.header('content-length', st.size);
  return reply.send(createReadStream(path));
}

/** Stream a request body to `path` atomically, verifying sha256 when given. */
export async function receiveFile(body: unknown, raw: Readable, path: string, sha256?: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.ozwell-upload-${generateToken().slice(0, 8)}`;
  const hash = createHash('sha256');
  let size = 0;
  const src: Readable = body instanceof Readable ? body : Buffer.isBuffer(body) ? Readable.from([body]) : typeof body === 'string' ? Readable.from([Buffer.from(body)]) : body && typeof body === 'object' ? Readable.from([Buffer.from(JSON.stringify(body))]) : raw;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return cb(new ApiError('limit_exceeded', 'upload too large'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(src, meter, createWriteStream(tmp, { mode: 0o644 }));
    const digest = hash.digest('hex');
    if (sha256 && sha256.toLowerCase() !== digest) throw new ApiError('checksum_mismatch', `sha256 mismatch: expected ${sha256}, got ${digest}`);
    await rename(tmp, path);
    return { path, size, sha256: digest };
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export default async function execRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config, desktop } = ctx;
  const signKey = deriveKey(ctx.token ?? 'auth-disabled:' + generateToken(), 'files');
  const gate = async () => {
    if (!config.exec) throw new ApiError('permission_denied', 'process and filesystem APIs are disabled (OZWELL_COMPUTER_EXEC=false)');
  };
  const root = config.fsRoot;
  const jobs = jobsFor(config, desktop);

  // Raw uploads: accept any content type as a stream.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.post('/api/v1/exec', {
    preHandler: gate,
    schema: {
      tags: ['exec'], summary: 'Run a command',
      description: 'Runs a non-interactive command and returns its output. With wait_ms it runs as a background job: 200 with the job if it ' +
        'finished in time, else 202 with a running job to poll via /exec/jobs/{id}. With ?stream=1 the response is NDJSON: ' +
        '{stream, data} chunks then {exit: result}. Disabled when OZWELL_COMPUTER_EXEC=false.',
      querystring: { type: 'object', properties: { stream: prop('string', 'Stream output as NDJSON when 1 or true') } },
      body: {
        type: 'object', required: ['cmd'], additionalProperties: false,
        properties: {
          cmd: prop('string', 'Executable, or a shell command line when args is empty (run through /bin/sh if it contains shell syntax)', { minLength: 1 }),
          args: prop('array', 'Arguments; when given, cmd runs directly without a shell', { items: { type: 'string' } }),
          cwd: prop('string', 'Working directory'),
          env: prop('object', 'Extra environment variables', { additionalProperties: { type: 'string' } }),
          timeout_ms: prop('integer', 'Kill the process group after this long (default 60 s; 1 h for jobs)', { minimum: 1 }),
          stdin: prop('string', 'Text fed to standard input'),
          shell: prop('boolean', 'Force (true) or prevent (false) running through /bin/sh'),
          wait_ms: prop('integer', `Run as a background job and wait up to this long for it (max ${MAX_WAIT_MS})`, { minimum: 0, maximum: MAX_WAIT_MS }),
        },
      },
      response: {
        200: {
          description: 'The command finished: its result, the job view when wait_ms was given, or an NDJSON stream with ?stream=1',
          content: {
            'application/json': { schema: { oneOf: [execResult, jobView] } },
            'application/x-ndjson': { schema: { type: 'string' } },
          },
        },
        202: { ...jobView, description: 'Still running after wait_ms; poll /exec/jobs/{job_id}' },
        ...errors,
      },
    },
  }, async (req, reply) => {
    const body = req.body as ExecRequest & { wait_ms?: number };
    const stream = ['1', 'true'].includes((req.query as any).stream);
    if (body.wait_ms !== undefined && !stream) {
      // Wait, then hand off: 200 with the result if it finished, else 202 with a job to poll.
      const shell = body.shell ?? !body.args?.length;
      const id = await jobs.start({ command: body.cmd, args: shell ? undefined : body.args ?? [], cwd: body.cwd, env: body.env, timeout_ms: body.timeout_ms, stdin: body.stdin });
      const v = await jobs.wait(id, body.wait_ms);
      return reply.code(v.state === 'running' ? 202 : 200).send(v);
    }
    if (!stream) return runCommand(body, desktop.x.displayName);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const ac = new AbortController();
    req.raw.on('close', () => { if (!reply.raw.writableEnded) ac.abort(); });
    try {
      await runCommand(body, desktop.x.displayName, (c) => reply.raw.write(JSON.stringify(c) + '\n'), ac.signal);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('internal', (e as Error).message);
      reply.raw.write(JSON.stringify(err.toBody()) + '\n');
    }
    reply.raw.end();
  });

  app.get('/api/v1/exec/jobs', {
    preHandler: gate,
    schema: {
      tags: ['exec'], summary: 'List background commands, newest first',
      description: 'Every job still on disk (finished jobs are kept for 24 h), without output. Starts, finishes and removals are also '
        + 'published on /api/v1/events as `job` and `job.removed` events.',
      response: { 200: record('The jobs', { jobs: prop('array', 'Jobs, newest first', { items: jobSummary }) }), ...errors },
    },
  }, async () => ({ jobs: await jobs.list() }));
  const jobParams = { type: 'object', properties: { id: prop('string', 'Job id (j-xxxxxxxxxxxx) from POST /api/v1/exec or GET /api/v1/exec/jobs') }, required: ['id'] };
  const offsetProps = {
    stdout_offset: prop('integer', 'Return stdout from this byte offset (from a previous view)', { minimum: 0 }),
    stderr_offset: prop('integer', 'Return stderr from this byte offset (from a previous view)', { minimum: 0 }),
  };
  app.get('/api/v1/exec/jobs/:id', {
    preHandler: gate,
    schema: {
      tags: ['exec'], summary: 'Wait for a background command and read its output', params: jobParams,
      description: 'Returns as soon as the job finishes or wait_ms elapses. Jobs survive server restarts and are kept for 24 h after finishing.',
      querystring: {
        type: 'object',
        properties: {
          wait_ms: prop('integer', 'How long to wait for the job to finish (default 0)', { minimum: 0, maximum: MAX_WAIT_MS }),
          ...offsetProps,
        },
      },
      response: { 200: jobView, ...errors },
    },
  }, async (req) => {
    const q = req.query as { wait_ms?: number; stdout_offset?: number; stderr_offset?: number };
    return jobs.wait((req.params as any).id, q.wait_ms ?? 0, { stdout: q.stdout_offset, stderr: q.stderr_offset });
  });
  const streamRoute = '/api/v1/exec/jobs/:id/stream';
  type Emit = (kind: 'output' | 'state' | 'end', data: Partial<JobView>) => void;
  /** Emit a job's new output and state changes until it stops, then `end` with its summary (unless aborted). */
  const relay = async (id: string, offsets: JobOffsets, signal: AbortSignal, drained: (signal: AbortSignal) => Promise<void>, emit: Emit) => {
    let last: JobView | null = null;
    for await (const v of jobs.follow(id, offsets, signal)) {
      const { stdout, stderr, stdout_offset, stderr_offset, truncated } = v;
      if (stdout || stderr || truncated) emit('output', { stdout, stderr, stdout_offset, stderr_offset, truncated });
      if (v.state !== last?.state) emit('state', summarize(v));
      last = v;
      await drained(signal);
    }
    if (signal.aborted || !last) return;
    emit('end', summarize(last));
  };
  app.get(streamRoute, {
    preHandler: gate,
    schema: {
      tags: ['exec'], summary: 'Stream a background command\'s output as server-sent events',
      description: 'Tails stdout/stderr from the given offsets. `output` events carry {stdout, stderr, stdout_offset, stderr_offset, truncated} '
        + 'with an event id of `<stdout_offset>-<stderr_offset>`; a `Last-Event-ID` header in that form overrides the query offsets, so '
        + 'EventSource reconnects resume where they left off. `state` events carry the job summary when its state changes. When the job '
        + 'is no longer running, a final `end` event with the summary is sent and the stream closes.',
      params: jobParams,
      querystring: { type: 'object', properties: offsetProps },
      response: { 200: media('An event stream that ends with the job', ['text/event-stream'], { type: 'string' }), ...errors },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { stdout_offset?: number; stderr_offset?: number };
    const resume = /^(\d+)-(\d+)$/.exec(String(req.headers['last-event-id'] ?? ''));
    const offsets = resume ? { stdout: Number(resume[1]), stderr: Number(resume[2]) } : { stdout: q.stdout_offset, stderr: q.stderr_offset };
    await jobs.summary(id); // 404 before the stream opens
    const { send, drained, signal, end } = openSse(reply, streamRoute);
    // A read that fails mid-stream (e.g. the job was pruned) just ends it; EventSource reconnects from its last id.
    await relay(id, offsets, signal, drained, (kind, data) =>
      send(kind, data, kind === 'output' ? `${data.stdout_offset}-${data.stderr_offset}` : undefined)).catch(() => undefined);
    if (!signal.aborted) end();
  });

  // The job each /api/v1/events stream currently carries output for, by stream_id.
  const followers = new Map<string, AbortController>();
  app.put('/api/v1/events/:stream_id/job', {
    preHandler: gate,
    schema: {
      tags: ['exec'], summary: 'Carry a background command\'s output on an event stream',
      description: 'Makes the /api/v1/events stream with this `stream_id` (from its `hello` event) tail one job, replacing any job it '
        + 'carried before; `job_id: null` stops. The stream then gets `job.output` events {job_id, stdout, stderr, stdout_offset, '
        + 'stderr_offset, truncated}, `job.state` with the job summary when its state changes, and `job.end` with the final summary '
        + 'once the job is no longer running. Each event also carries the `tag` given here. A reconnected stream has a new '
        + '`stream_id`, so subscribe again with the last offsets received.',
      params: {
        type: 'object', required: ['stream_id'],
        properties: { stream_id: prop('string', 'The `stream_id` from the stream\'s `hello` event') },
      },
      body: {
        type: 'object', required: ['job_id'], additionalProperties: false,
        properties: {
          job_id: prop(['string', 'null'], 'Job id (j-xxxxxxxxxxxx) to tail, or null to stop'),
          ...offsetProps,
          tag: prop('string', 'Echoed in this subscription\'s events, to tell them from an earlier subscription\'s', { maxLength: 64 }),
        },
      },
      response: { 200: ok, ...errors },
    },
  }, async (req) => {
    const { stream_id } = req.params as { stream_id: string };
    const b = req.body as { job_id: string | null; stdout_offset?: number; stderr_offset?: number; tag?: string };
    const stream = eventStreams.get(stream_id);
    if (!stream) throw new ApiError('target_unavailable', `no event stream ${stream_id}`);
    followers.get(stream_id)?.abort();
    followers.delete(stream_id);
    const { job_id, tag } = b;
    if (job_id === null) return { ok: true };
    const ac = new AbortController();
    followers.set(stream_id, ac);
    const signal = AbortSignal.any([stream.signal, ac.signal]);
    const done = () => { if (followers.get(stream_id) === ac) followers.delete(stream_id); };
    await jobs.summary(job_id).catch((e) => { done(); throw e; });
    void relay(job_id, { stdout: b.stdout_offset, stderr: b.stderr_offset }, signal, stream.drained, (kind, data) =>
      stream.send(`job.${kind}`, kind === 'output' ? { job_id, ...data, tag } : { ...data, tag }))
      // Close the shared stream so the viewer reconnects and resubscribes (or sees the job is gone).
      .catch(() => { if (!signal.aborted) stream.end(); })
      .finally(done);
    return { ok: true };
  });
  app.delete('/api/v1/exec/jobs/:id', {
    preHandler: gate,
    schema: {
      tags: ['exec'], summary: 'Cancel a background command', params: jobParams,
      description: 'Kills the job\'s process group if it is running, then returns its view (waiting up to 2 s for it to end).',
      response: { 200: jobView, ...errors },
    },
  }, async (req) => jobs.cancel((req.params as any).id));

  app.get('/api/v1/pty', { websocket: true, preHandler: gate, schema: { hide: true } }, async (socket, req) => {
    const pty = await loadPty();
    if (!pty) {
      socket.send(JSON.stringify(new ApiError('feature_unsupported', 'node-pty is not installed', { feature: 'pty' }).toBody()));
      socket.close(1011);
      return;
    }
    const q = req.query as Record<string, string>;
    const shell = q.shell || process.env.SHELL || '/bin/bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color', cols: Number(q.cols) || 80, rows: Number(q.rows) || 24,
      cwd: q.cwd || process.env.HOME || '/', env: { ...process.env, DISPLAY: desktop.x.displayName, TERM: 'xterm-256color' },
    });
    term.onData((d: string) => { if (socket.readyState === 1) socket.send(d); });
    term.onExit(({ exitCode }: { exitCode: number }) => {
      if (socket.readyState === 1) { socket.send(JSON.stringify({ exit: exitCode })); socket.close(1000); }
    });
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const s = data.toString('utf8');
      if (!isBinary && s.startsWith('{"resize"')) {
        try {
          const { resize } = JSON.parse(s);
          if (Array.isArray(resize)) term.resize(Math.max(1, resize[0] | 0), Math.max(1, resize[1] | 0));
          return;
        } catch { /* fallthrough: treat as input */ }
      }
      term.write(s);
    });
    socket.on('close', () => { try { term.kill(); } catch { /* gone */ } });
  });

  const pathQuery = {
    type: 'object', required: ['path'],
    properties: {
      path: fsPath,
      sha256: prop('string', 'Expected SHA-256 (hex) of the upload; a mismatch fails with checksum_mismatch and nothing is written'),
      recursive: prop('string', 'Delete a directory and its contents when 1 or true'),
    },
  };
  const fileContent = (description: string) => media(description, ['application/octet-stream'], undefined, {
    headers: { 'accept-ranges': prop('string', 'Always bytes'), 'last-modified': prop('string', 'File modification time') },
  });

  app.get('/api/v1/fs', {
    preHandler: gate,
    schema: {
      tags: ['fs'], summary: 'Stat a path or list a directory', querystring: pathQuery,
      description: 'Returns the entry; directories also include their sorted entries. Only path is used.',
      response: { 200: fsStat, ...errors },
    },
  }, async (req) => {
    const path = safePath(root, (req.query as any).path);
    const info = await statEntry(path);
    if (info.type !== 'directory') return info;
    const names = await readdir(path);
    const entries = [];
    for (const n of names.sort()) {
      try { entries.push({ name: n, ...(await statEntry(`${path === '/' ? '' : path}/${n}`)) }); } catch { /* raced */ }
    }
    return { ...info, entries };
  });

  app.get('/api/v1/fs/content', {
    preHandler: gate,
    schema: {
      tags: ['fs'], summary: 'Download a file', querystring: pathQuery,
      description: 'Streams a regular file. Supports a single Range: bytes=start-end header. Only path is used.',
      response: {
        200: fileContent('The whole file'),
        206: fileContent('The requested byte range (see Content-Range)'),
        ...errors,
      },
    },
  }, async (req, reply) =>
    sendFile(req, reply, safePath(root, (req.query as any).path)));

  app.put('/api/v1/fs/content', {
    preHandler: gate, bodyLimit: MAX_UPLOAD,
    schema: {
      tags: ['fs'], summary: 'Upload a file', querystring: pathQuery,
      description: 'The request body (up to 2 GiB) is written atomically to path, creating parent directories. Optionally verified against sha256. ' +
        'Send application/octet-stream (or any type without a built-in parser) to write the bytes unchanged; ' +
        'application/json bodies are parsed and re-serialized, and text/plain is decoded as UTF-8.',
      response: { 200: upload, ...errors },
    },
    // Documentation only: a body schema would make Fastify validate the upload stream.
    config: {
      swaggerTransform: ({ schema, url }) => ({
        schema: { ...schema, body: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary', description: 'File contents' } } } } },
        url,
      }),
    },
  }, async (req) => {
    const q = req.query as any;
    return receiveFile(req.body, req.raw, safePath(root, q.path), q.sha256);
  });

  app.delete('/api/v1/fs', {
    preHandler: gate,
    schema: {
      tags: ['fs'], summary: 'Delete a file or directory', querystring: pathQuery,
      description: 'Directories require recursive=1.',
      response: { 200: ok, ...errors },
    },
  }, async (req) => {
    const q = req.query as any;
    const path = safePath(root, q.path);
    const recursive = q.recursive === '1' || q.recursive === 'true';
    if ((await lstat(path)).isDirectory() && !recursive) throw new ApiError('invalid_request', 'path is a directory; pass recursive=1 to delete it');
    await rm(path, { recursive });
    return { ok: true };
  });

  app.post('/api/v1/fs/move', {
    preHandler: gate,
    schema: {
      tags: ['fs'], summary: 'Move or rename a path', description: 'Creates the destination\'s parent directories.',
      body: { type: 'object', required: ['from', 'to'], properties: { from: { ...fsPath, description: 'Existing path' }, to: { ...fsPath, description: 'New path' } } },
      response: { 200: ok, ...errors },
    },
  }, async (req) => {
    const b = req.body as { from: string; to: string };
    const to = safePath(root, b.to);
    await mkdir(dirname(to), { recursive: true });
    await rename(safePath(root, b.from), to);
    return { ok: true };
  });

  app.post('/api/v1/fs/mkdir', {
    preHandler: gate,
    schema: {
      tags: ['fs'], summary: 'Create a directory', description: 'Creates parents as needed; succeeds if it already exists.',
      body: { type: 'object', required: ['path'], properties: { path: fsPath } },
      response: { 200: ok, ...errors },
    },
  }, async (req) => {
    await mkdir(safePath(root, (req.body as any).path), { recursive: true });
    return { ok: true };
  });

  app.post('/api/v1/fs/sign', {
    preHandler: gate,
    schema: {
      tags: ['fs'], summary: 'Create a signed URL for a file',
      description: 'The URL downloads (GET) or uploads (PUT, raw body, optional ?sha256=) the file without any other credentials until it expires.',
      body: {
        type: 'object', required: ['path'],
        properties: {
          path: fsPath,
          method: prop('string', 'What the URL allows (default GET)', { enum: ['GET', 'PUT'] }),
          ttl_s: prop('integer', 'Lifetime in seconds (default 3600)', { minimum: 1, maximum: 7 * 86400 }),
        },
      },
      response: {
        200: record('A signed URL', {
          url: prop('string', 'Server-relative URL (/files/...?exp=...&sig=...)'),
          expires_at: prop('integer', 'Expiry (seconds since epoch)'),
          method: prop('string', 'The method the URL is valid for', { enum: ['GET', 'PUT'] }),
        }),
        ...errors,
      },
    },
  }, async (req) => {
    const b = req.body as { path: string; method?: SignMethod; ttl_s?: number };
    const path = safePath(root, b.path);
    return { ...signedUrl(signKey, b.method ?? 'GET', path, b.ttl_s ?? 3600), method: b.method ?? 'GET' };
  });

  const filesHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    await gate();
    const method: SignMethod = req.method === 'PUT' ? 'PUT' : 'GET';
    const wildcard = (req.params as any)['*'] as string;
    let path: string;
    try { path = '/' + wildcard.split('/').map(decodeURIComponent).join('/'); } catch { throw new ApiError('invalid_request', 'bad path'); }
    const q = req.query as any;
    if (!verifySignature(signKey, method, path, Number(q.exp), q.sig)) {
      return reply.code(403).send(new ApiError('permission_denied', 'invalid or expired signature').toBody());
    }
    const full = safePath(root, path);
    if (method === 'PUT') return receiveFile(req.body, req.raw, full, q.sha256);
    return sendFile(req, reply, full);
  };
  app.get('/files/*', { schema: { hide: true } }, filesHandler);
  app.put('/files/*', { bodyLimit: MAX_UPLOAD, schema: { hide: true } }, filesHandler);
}
