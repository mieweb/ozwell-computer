import { cpSync, chmodSync } from 'node:fs';
cpSync('src/web/static', 'dist/web/static', { recursive: true });
chmodSync('dist/cli.js', 0o755);
