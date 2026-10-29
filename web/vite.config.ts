import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The server sends dist/web/static/index.html for / (see src/web/routes.ts).
export default defineConfig({
  root: here('.'),
  base: '/static/',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: here('../dist/web/static'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { external: ['/novnc/core/rfb.js'] },
  },
});
