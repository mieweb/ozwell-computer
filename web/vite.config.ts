import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Fixed file names: the server renders the HTML that references them (see src/web/routes.ts).
export default defineConfig({
  root: here('.'),
  base: '/static/',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: here('../dist/web/static'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: { viewer: here('src/main.tsx'), login: here('src/login.css') },
      external: ['/novnc/core/rfb.js'],
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js', assetFileNames: '[name][extname]' },
    },
  },
});
