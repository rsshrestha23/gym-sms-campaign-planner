import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    // API test files share one database, so run files one at a time (the suite is small).
    fileParallelism: false,
    projects: [
      {
        test: {
          // API, dispatcher, and worker tests share the PostgreSQL + Redis containers.
          name: 'api',
          root: './packages/api',
          include: ['test/**/*.test.ts', '../dispatcher/test/**/*.test.ts', '../workers/test/**/*.test.ts'],
          environment: 'node',
          // One isolated Testcontainers PostgreSQL instance for the whole run.
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          root: './packages/web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
