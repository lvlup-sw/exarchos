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
