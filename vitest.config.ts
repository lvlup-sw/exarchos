import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          // Root-package unit tests only. Tests under `servers/exarchos-mcp/`
          // are owned by that workspace's own `vitest.config.ts` (which sets up
          // the `bun:sqlite` alias and resolves `@fast-check/vitest` from the
          // nested `node_modules/`). CI runs them via `cd servers/exarchos-mcp
          // && npm run test:run`.
          include: [
            'src/**/*.test.ts',
            'benchmarks/**/*.test.ts',
            'scripts/**/*.test.ts',
            'test/fixtures/**/*.test.ts',
            'test/setup/**/*.test.ts',
            'test/migration/**/*.test.ts',
            'test/smoke/**/*.test.ts',
            'test/e2e/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'process',
          include: ['test/process/**/*.test.ts'],
          testTimeout: 15000,
          setupFiles: ['./test/setup/global.ts'],
        },
      },
    ],
  },
});
