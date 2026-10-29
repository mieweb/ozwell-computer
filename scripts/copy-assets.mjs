import { chmodSync } from 'node:fs';
chmodSync('dist/cli.js', 0o755);
