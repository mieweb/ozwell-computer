import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server talks to Firefox's ozwell-computer extension (contrib/firefox/extension)
// through its native messaging host (native-host.ts), which Firefox starts and which
// connects to the server's Unix socket. Both legs use native messaging framing: a 32-bit
// little-endian length, then that many bytes of UTF-8 JSON.
//
//   server → extension: {id, method, params}
//   extension → server: {id, result} or {id, error}

/** Larger frames are a protocol error (a cookie listing is far smaller). */
export const MAX_FRAME = 64 * 1024 * 1024;

/**
 * The socket the server listens on and the host connects to. Firefox inherits the
 * session's XDG_RUNTIME_DIR (the server sets the same one, see sessionEnv), so both
 * ends agree; owner-only permissions on it keep other users out.
 */
export function browserSocketPath(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.()): string {
  const runtime = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : tmpdir());
  return join(runtime, 'ozwell-computer', 'browser.sock');
}

export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into whole frames; push() returns the bodies completed so far. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes exceeds ${MAX_FRAME}`);
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
