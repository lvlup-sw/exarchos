import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'benchmarks/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
});
