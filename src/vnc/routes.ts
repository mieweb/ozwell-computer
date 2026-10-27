import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../server.js';
import { RfbSession } from './rfb-server.js';

export function parseExternal(backend: string): { host: string; port: number } | null {
  const m = /^external:(?:([\w.-]+):)?(\d+)$/.exec(backend);
  return m ? { host: m[1] ?? '127.0.0.1', port: Number(m[2]) } : null;
}

/** Proxy a WebSocket to a TCP VNC server (no websockify needed). */
function bridgeTcp(ws: WebSocket, host: string, port: number) {
  const sock = connect({ host, port });
  sock.on('data', (d) => {
    if (ws.readyState !== 1) return;
    ws.send(d, { binary: true });
    if (ws.bufferedAmount > 8 * 1024 * 1024) sock.pause();
  });
  const drain = setInterval(() => { if (sock.isPaused() && ws.bufferedAmount < 1024 * 1024) sock.resume(); }, 20);
  sock.on('close', () => { clearInterval(drain); ws.close(1000); });
  sock.on('error', () => { clearInterval(drain); ws.close(1011, 'backend unavailable'); });
  ws.on('message', (d: Buffer) => sock.write(d));
  ws.on('close', () => { clearInterval(drain); sock.destroy(); });
}

export default async function vncRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config, desktop, log } = ctx;
  const external = parseExternal(config.vncBackend);

  app.get('/websockify', { websocket: true, schema: { hide: true } }, (socket, req) => {
    const ws = socket as unknown as WebSocket;
    if (external) return bridgeTcp(ws, external.host, external.port);
    let session: RfbSession;
    try {
      const q = req.query as Record<string, string>;
      const viewOnly = config.viewOnly || q.view_only === '1';
      session = new RfbSession(desktop, {
        send: (b) => { if (ws.readyState === 1) ws.send(b, { binary: true }); },
        close: (reason) => { if (ws.readyState === 1) ws.close(1000, reason?.slice(0, 120)); },
        buffered: () => ws.bufferedAmount,
      }, { viewOnly, name: `ozwell-desktop ${desktop.x.displayName}`, participantName: q.name?.slice(0, 64), participantId: q.participant }, log);
    } catch (e) {
      ws.close(1011, (e as Error).message.slice(0, 120));
      return;
    }
    ws.on('message', (d: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d);
      session.feed(buf);
    });
    ws.on('close', () => session.close('client closed'));
    ws.on('error', () => session.close('socket error'));
  });
}
