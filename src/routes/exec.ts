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
import { loadPty } from '../process/pty.js';
import { parseRange, safePath, signedUrl, verifySignature, type SignMethod } from '../fs/index.js';
import { deriveKey, generateToken } from '../auth/token.js';

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
    if (!config.exec) throw new ApiError('permission_denied', 'process and filesystem APIs are disabled (OZWELL_DESKTOP_EXEC=false)');
  };
  const root = config.fsRoot;

  // Raw uploads: accept any content type as a stream.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.post('/api/v1/exec', {
    preHandler: gate,
    schema: {
      tags: ['exec'],
      querystring: { type: 'object', properties: { stream: { type: 'string' } } },
      body: {
        type: 'object', required: ['cmd'], additionalProperties: false,
        properties: {
          cmd: { type: 'string', minLength: 1 }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' },
          env: { type: 'object', additionalProperties: { type: 'string' } }, timeout_ms: { type: 'integer', minimum: 1 },
          stdin: { type: 'string' }, shell: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as ExecRequest;
    const stream = ['1', 'true'].includes((req.query as any).stream);
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

  const pathQuery = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sha256: { type: 'string' }, recursive: { type: 'string' } } };

  app.get('/api/v1/fs', { preHandler: gate, schema: { tags: ['fs'], querystring: pathQuery } }, async (req) => {
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

  app.get('/api/v1/fs/content', { preHandler: gate, schema: { tags: ['fs'], querystring: pathQuery } }, async (req, reply) =>
    sendFile(req, reply, safePath(root, (req.query as any).path)));

  app.put('/api/v1/fs/content', { preHandler: gate, bodyLimit: MAX_UPLOAD, schema: { tags: ['fs'], querystring: pathQuery } }, async (req) => {
    const q = req.query as any;
    return receiveFile(req.body, req.raw, safePath(root, q.path), q.sha256);
  });

  app.delete('/api/v1/fs', { preHandler: gate, schema: { tags: ['fs'], querystring: pathQuery } }, async (req) => {
    const q = req.query as any;
    const path = safePath(root, q.path);
    const recursive = q.recursive === '1' || q.recursive === 'true';
    if ((await lstat(path)).isDirectory() && !recursive) throw new ApiError('invalid_request', 'path is a directory; pass recursive=1 to delete it');
    await rm(path, { recursive });
    return { ok: true };
  });

  app.post('/api/v1/fs/move', {
    preHandler: gate,
    schema: { tags: ['fs'], body: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  }, async (req) => {
    const b = req.body as { from: string; to: string };
    const to = safePath(root, b.to);
    await mkdir(dirname(to), { recursive: true });
    await rename(safePath(root, b.from), to);
    return { ok: true };
  });

  app.post('/api/v1/fs/mkdir', {
    preHandler: gate,
    schema: { tags: ['fs'], body: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  }, async (req) => {
    await mkdir(safePath(root, (req.body as any).path), { recursive: true });
    return { ok: true };
  });

  app.post('/api/v1/fs/sign', {
    preHandler: gate,
    schema: {
      tags: ['fs'],
      body: {
        type: 'object', required: ['path'],
        properties: { path: { type: 'string' }, method: { type: 'string', enum: ['GET', 'PUT'] }, ttl_s: { type: 'integer', minimum: 1, maximum: 7 * 86400 } },
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
