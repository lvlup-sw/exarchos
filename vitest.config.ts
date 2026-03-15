import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'companion/**/*.test.ts', 'benchmarks/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
});
