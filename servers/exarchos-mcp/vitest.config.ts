import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'src/bench/**/*.bench.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/bench/**/*.bench.ts', 'src/index.ts', 'src/__tests__/**', 'src/types.ts']
    }
  },
  benchmark: {
    include: ['src/**/*.bench.ts'],
    outputJson: 'benchmark-results.json',
  },
});
