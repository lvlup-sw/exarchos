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
