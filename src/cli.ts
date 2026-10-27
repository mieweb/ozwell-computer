#!/usr/bin/env node
import pino from 'pino';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { HELP, loadConfig, type Config } from './config.js';
import { resolveToken } from './auth/token.js';
import { redactUrl } from './auth/plugin.js';
import { Desktop } from './desktop.js';
import { buildServer, VERSION } from './server.js';
import { A11y } from './a11y/atspi.js';
import { ptyAvailable } from './process/pty.js';

export function createLogger(level: string) {
  return pino({
    level,
    redact: { paths: ['req.headers.authorization', 'req.headers["x-auth-token"]', 'req.headers.cookie'], censor: 'REDACTED' },
    serializers: {
      req: (req: any) => ({ method: req.method, url: redactUrl(req.url ?? ''), remoteAddress: req.ip }),
    },
  });
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
 * Print a startup message to stderr and, when OZWELL_DESKTOP_CONSOLE names a writable
 * terminal (set by the container's systemd unit), there too, so `docker logs` shows it.
 */
function banner(text: string) {
  const msg = `\n${text}\n\n`;
  process.stderr.write(msg);
  const consolePath = process.env.OZWELL_DESKTOP_CONSOLE;
  if (consolePath) {
    try { appendFileSync(consolePath, msg.replace(/\n/g, '\r\n')); } catch { /* no TTY attached */ }
  }
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

  const log = createLogger(args.printOpenapi ? 'silent' : config.logLevel);
  let token: string | null = null;
  let tokenSource: 'config' | 'file' | 'generated' | null = null;
  if (!config.authDisabled && !args.printOpenapi) {
    const t = await resolveToken(config.token, config.tokenFile);
    token = t.token;
    tokenSource = t.source;
  }

  const xvfb = args.printOpenapi ? null : await maybeSpawnXvfb(config, log);
  const desktop = new Desktop(config.display, log);
  const a11y = config.a11y === 'off' ? null : new A11y(config.a11y, log, desktop);
  const app = await buildServer({ config, desktop, token, version: VERSION, a11y, ptyAvailable: await ptyAvailable(), log });

  if (args.printOpenapi) {
    await app.ready();
    process.stdout.write(JSON.stringify(app.swagger(), null, 2) + '\n');
    await app.close();
    return;
  }

  await desktop.start();
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
    banner(`ozwell-desktop: ${how} (stored in ${config.tokenFile})\n  open ${openUrl}`);
  } else {
    log.info(`viewer: ${base}?token=<OZWELL_DESKTOP_TOKEN>`);
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
    await desktop.stop();
    await a11y?.close();
    xvfb?.removeAllListeners('exit');
    xvfb?.kill();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`ozwell-desktop: ${(e as Error)?.message ?? e}\n`);
  if (process.env.OZWELL_DESKTOP_LOG_LEVEL === 'debug') process.stderr.write(`${(e as Error)?.stack}\n`);
  process.exit(1);
});
