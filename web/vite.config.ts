import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// New on every build (which an update always runs), so it also covers noVNC, which is loaded from /novnc, not bundled.
const build = randomBytes(12).toString('base64url');

// The server sends dist/web/static/index.html for / (see src/web/routes.ts) and reports build-id in `hello`.
export default defineConfig({
  root: here('.'),
  base: '/static/',
  publicDir: false,
  define: { __VIEWER_BUILD__: JSON.stringify(build) },
  plugins: [react(), tailwindcss(), {
    name: 'build-id',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-id', source: build }); },
  }],
  build: {
    outDir: here('../dist/web/static'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { external: ['/novnc/core/rfb.js'] },
  },
});
