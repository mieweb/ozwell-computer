/**
 * Firefox's native messaging host for the ozwell-computer extension. Firefox starts it
 * (through bin/ozwell-computer-browser-host) when the extension connects, and stops it by
 * closing stdin when the extension or the browser goes away. It relays whole frames
 * between Firefox (stdin/stdout) and the server's socket, reconnecting while the server
 * restarts; frames sent meanwhile are dropped (the server has failed those calls already).
 */
import { connect, type Socket } from 'node:net';
import { FrameReader, browserSocketPath } from './protocol.js';

const RETRY_MS = 1000;
const path = browserSocketPath();
let socket: Socket | null = null;

const header = (len: number) => { const h = Buffer.alloc(4); h.writeUInt32LE(len); return h; };
const relay = (out: { write(b: Buffer): unknown }, body: Buffer) => out.write(Buffer.concat([header(body.length), body]));

function open() {
  const s = connect(path);
  const reader = new FrameReader();
  s.on('connect', () => { socket = s; });
  s.on('data', (chunk: Buffer) => {
    try {
      for (const body of reader.push(chunk)) relay(process.stdout, body);
    } catch {
      s.destroy();
    }
  });
  s.on('error', () => undefined); // 'close' follows
  s.on('close', () => {
    if (socket === s) socket = null;
    setTimeout(open, RETRY_MS).unref();
  });
}

const fromFirefox = new FrameReader();
process.stdin.on('data', (chunk: Buffer) => {
  let bodies: Buffer[];
  try { bodies = fromFirefox.push(chunk); } catch { process.exit(1); }
  for (const body of bodies) if (socket) relay(socket, body);
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
// Keep running (and retrying) while Firefox holds stdin open.
process.stdin.resume();
open();
