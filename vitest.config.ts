import { defineConfig } from 'vitest/config';

// `npm test` runs everything: fast unit tests plus the integration suite against a
// throwaway container (API, VNC, MCP, a11y, and Chromium/Firefox viewer tests).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 20000 } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 60000,
          hookTimeout: 120000,
          fileParallelism: false,
        },
      },
    ],
  },
});
