import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'src/**/*.test.ts',
            'benchmarks/**/*.test.ts',
            'scripts/**/*.test.ts',
            'test/fixtures/**/*.test.ts',
            'test/setup/**/*.test.ts',
            'test/migration/**/*.test.ts',
            'test/smoke/**/*.test.ts',
            'test/e2e/**/*.test.ts',
            'servers/exarchos-mcp/src/**/*.test.ts',
          ],
          // Prevent cross-project duplicate execution: __tests__ is owned by
          // the `integration` project below. Without this, the unit project's
          // `servers/exarchos-mcp/src/**/*.test.ts` glob would also match it.
          // We re-list the vitest defaults so they are preserved when
          // `exclude` is set explicitly.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/cypress/**',
            '**/.{idea,git,cache,output,temp}/**',
            '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
            'servers/exarchos-mcp/src/__tests__/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['servers/exarchos-mcp/src/__tests__/**/*.test.ts'],
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
