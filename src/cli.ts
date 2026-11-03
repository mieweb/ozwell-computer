#!/usr/bin/env node
import pino from 'pino';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, writeSync } from 'node:fs';
import { HELP, loadConfig, sessionEnv, type Config } from './config.js';
import { resolveToken } from './auth/token.js';
import { redactUrl } from './auth/plugin.js';
import { Desktop } from './desktop.js';
import { buildServer, VERSION } from './server.js';
import { A11y } from './a11y/atspi.js';
import { ptyAvailable } from './process/pty.js';
import { Updater } from './update.js';
import { ensureSettingsDaemon } from './theme.js';

/**
 * Mirror of our output onto a terminal named by OZWELL_COMPUTER_CONSOLE. The container's
 * systemd unit sets it to /dev/console so that `docker logs` (with a TTY) shows this
 * service's output, and only that. Without a TTY the path doesn't exist and this is a no-op.
 */
const consoleFd: number | null = (() => {
  const path = process.env.OZWELL_COMPUTER_CONSOLE;
  if (!path) return null;
  try { return openSync(path, 'a'); } catch { return null; }
})();
function toConsole(text: string) {
  if (consoleFd === null) return;
  try { writeSync(consoleFd, text); } catch { /* console went away */ }
}

export function createLogger(level: string) {
  const opts = {
    level,
    redact: { paths: ['req.headers.authorization', 'req.headers["x-auth-token"]', 'req.headers.cookie'], censor: 'REDACTED' },
    serializers: {
      req: (req: any) => ({ method: req.method, url: redactUrl(req.url ?? ''), route: req.routeOptions?.url, remoteAddress: req.ip }),
    },
  };
  if (consoleFd === null) return pino(opts);
  return pino(opts, pino.multistream([
    { level: level as pino.Level, stream: pino.destination({ fd: 1, sync: true }) },
    { level: level as pino.Level, stream: { write: toConsole } },
  ]));
}

function displaySocket(display: string): string | null {
  const m = /^:(\d+)/.exec(display);
  return m ? `/tmp/.X11-unix/X${m[1]}` : null;
}

async function maybeSpawnXvfb(config: Config, log: pino.Logger): Promise<ChildProcess | null> {
  if (!config.spawnXvfb) return null;
  const sock = displaySocket(config.display);
  if (sock && existsSync(sock)) {
    log.info({ display: config.display }, 'display already running; not spawning Xvfb');
    return null;
  }
  const [w, h, d = '24'] = config.screen.split('x');
  const child = spawn('Xvfb', [config.display, '-screen', '0', `${w}x${h}x${d}`, '-nolisten', 'tcp', '+extension', 'RANDR', '+extension', 'DAMAGE'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-2000);
    log.debug({ xvfb: b.toString().trim() });
  });
  // Fail startup if Xvfb can't be executed, exits early, or never creates its socket.
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.off('exit', onExit);
      err ? reject(err) : resolve();
    };
    const onExit = (code: number | null, sig: string | null) =>
      finish(new Error(`Xvfb exited during startup (code ${code}${sig ? `, signal ${sig}` : ''})${stderr ? `: ${stderr.trim()}` : ''}`));
    child.once('error', (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === 'ENOENT' ? 'Xvfb not found in PATH; install it (e.g. apt install xvfb) or omit --spawn-xvfb' : `failed to start Xvfb: ${e.message}`)));
    child.once('exit', onExit);
    const poll = setInterval(() => { if (!sock || existsSync(sock)) finish(); }, 100);
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Xvfb did not create ${sock} within 10s`));
    }, 10_000);
  });
  // We own this X server: if it dies later, the service is useless, so exit non-zero.
  child.once('exit', (code, sig) => {
    log.fatal({ code, sig }, 'spawned Xvfb exited; shutting down');
    process.exit(1);
  });
  log.info({ display: config.display, screen: config.screen }, 'spawned Xvfb');
  return child;
}

/**
 * Print a startup message to stderr and, when OZWELL_COMPUTER_CONSOLE names a writable
 * terminal (set by the container's systemd unit), there too, so `docker logs` shows it.
 */
function banner(text: string) {
  const msg = `\n${text}\n\n`;
  process.stderr.write(msg);
  toConsole(msg);
}

/** Open a URL in the user's default browser; failures are logged, never fatal. */
function openInBrowser(url: string, log: pino.Logger) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => log.warn({ err: e.message }, 'could not open a browser'));
    child.unref();
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'could not open a browser');
  }
}

/** tools/list over plain JSON-RPC against an MCP endpoint (auth disabled). */
async function listOwnMcpTools(url: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const rpc = async (body: object) => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    return { res: r, msg: json ? JSON.parse(json) : null };
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'catalog', version: '1' } } });
  headers['mcp-session-id'] = init.res.headers.get('mcp-session-id') ?? '';
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await fetch(url, { method: 'DELETE', headers }).catch(() => undefined);
  return (list.msg?.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function main() {
  let loaded;
  try {
    loaded = loadConfig(process.env, process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  const { config, args } = loaded;
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) { process.stdout.write(VERSION + '\n'); return; }
  // Before anything connects to the bus or spawns: children inherit process.env.
  Object.assign(process.env, sessionEnv(process.env));

  const offline = args.printMcpTools;
  const log = createLogger(offline ? 'silent' : config.logLevel);
  let token: string | null = null;
  let tokenSource: 'config' | 'file' | 'generated' | null = null;
  if (!config.authDisabled && !offline) {
    const t = await resolveToken(config.token, config.tokenFile);
    token = t.token;
    tokenSource = t.source;
  }

  const xvfb = offline ? null : await maybeSpawnXvfb(config, log);
  // A fresh Xvfb has no XSETTINGS provider: serve the saved (xfconf) theme on it.
  if (xvfb) await ensureSettingsDaemon(config.display).catch((e) => log.warn({ err: (e as Error).message }, 'cannot serve the desktop theme'));
  const desktop = new Desktop(config.display, log);
  const a11y = config.a11y === 'off' ? null : new A11y(config.a11y, log, desktop);
  const updater = offline ? null
    : new Updater(config.updateUrl === 'off' ? null : config.updateUrl, log, (s) => desktop.bus.publish('update.status', s));
  const app = await buildServer({ config, desktop, token, version: VERSION, a11y, ptyAvailable: await ptyAvailable(), updater, log });

  if (args.printMcpTools) {
    // The catalog the orchestrator proxies (orchestrator/ reads docs/mcp-tools.json).
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    process.stdout.write(JSON.stringify({ tools: await listOwnMcpTools(`http://127.0.0.1:${port}/mcp`) }, null, 2) + '\n');
    await app.close();
    return;
  }

  await desktop.start();
  void updater?.start();
  await app.listen({ port: config.port, host: config.host });

  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const base = (config.publicUrl ?? `http://${shownHost}:${port}`).replace(/\/+$/, '') + '/';
  let openUrl = base;
  if (config.authDisabled) {
    log.warn('AUTHENTICATION IS DISABLED: anyone who can reach this port controls the desktop');
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host))
      log.warn({ host: config.host }, 'listening on a non-loopback address with authentication disabled');
    log.info(`viewer: ${base}`);
  } else if (tokenSource !== 'config') {
    // The token was generated by us (now or on an earlier run), so it is fine to show it.
    // Configured tokens are never printed. Written to stderr, not the structured log.
    openUrl = `${base}?token=${encodeURIComponent(token!)}`;
    const how = tokenSource === 'generated' ? 'generated a token' : 'using the generated token';
    banner(`ozwell-computer: ${how} (stored in ${config.tokenFile})\n  open ${openUrl}`);
  } else {
    log.info(`viewer: ${base}?token=<OZWELL_COMPUTER_TOKEN>`);
  }
  if (config.open) openInBrowser(openUrl, log);

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'shutting down');
    const t = setTimeout(() => process.exit(1), 5000);
    t.unref();
    await app.close().catch(() => undefined);
    updater?.stop();
    await desktop.stop();
    await a11y?.close();
    xvfb?.removeAllListeners('exit');
    xvfb?.kill();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

process.on('uncaughtException', (e) => {
  toConsole(`ozwell-computer: uncaught exception: ${e?.stack ?? e}\n`);
  process.stderr.write(`ozwell-computer: uncaught exception: ${e?.stack ?? e}\n`);
  process.exit(1);
});

main().catch((e) => {
  toConsole(`ozwell-computer: ${(e as Error)?.message ?? e}\n`);
  process.stderr.write(`ozwell-computer: ${(e as Error)?.message ?? e}\n`);
  if (process.env.OZWELL_COMPUTER_LOG_LEVEL === 'debug') process.stderr.write(`${(e as Error)?.stack}\n`);
  process.exit(1);
});
