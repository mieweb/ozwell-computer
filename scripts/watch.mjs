// `npm run watch`: rebuild on change and refresh the compose dev container.
//  - server code (src/**/*.ts): tsc --watch, then restart the Node server in the container
//  - viewer assets (src/web/static): copied to dist; just reload the browser
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isRunning, restartServer } from './compose.mjs';

const log = (m) => process.stdout.write(`[watch] ${m}\n`);
const STATIC_SRC = join(ROOT, 'src/web/static');
const STATIC_DST = join(ROOT, 'dist/web/static');

function copyStatic() {
  mkdirSync(STATIC_DST, { recursive: true });
  cpSync(STATIC_SRC, STATIC_DST, { recursive: true });
}

let restartTimer = null;
function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!existsSync(join(ROOT, 'dist/cli.js'))) return;
    if (!isRunning()) { log('built; compose service not running (docker compose up -d)'); return; }
    const t = Date.now();
    try {
      restartServer();
      log(`server restarted (${Date.now() - t} ms)`);
    } catch (e) {
      log(`restart failed: ${e.message.split('\n')[0]}`);
    }
  }, 300);
}

copyStatic();
watch(STATIC_SRC, { recursive: true }, () => {
  try { copyStatic(); log('viewer assets updated; reload the page'); } catch { /* mid-write */ }
});

// tsc rewrites only changed outputs; restart when any server JS lands in dist.
mkdirSync(join(ROOT, 'dist'), { recursive: true });
watch(join(ROOT, 'dist'), { recursive: true }, (_ev, file) => {
  if (file && file.endsWith('.js') && !file.startsWith(join('web', 'static'))) scheduleRestart();
});

const tsc = spawn(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
  cwd: ROOT, stdio: 'inherit',
});
tsc.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => { tsc.kill(); process.exit(0); });
