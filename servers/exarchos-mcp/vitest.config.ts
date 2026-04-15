import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'src/bench/**/*.bench.ts'],
    // Cold-start bench (src/bench/cli-startup.bench.ts) isolation strategy
    // (F-021-2):
    //   - `describe.sequential(...)` in the bench file forces its two
    //     telemetry variants to run back-to-back rather than interleaved.
    //   - Strict p95 assertions gate on `CI === '1'` or `BENCH_STRICT === '1'`
    //     so that parallel vitest worker contention on dev laptops does not
    //     flake the wall-clock measurement. CI runners are otherwise idle
    //     and enforce the real numbers.
    // No pool-level config change is needed; keeping default `forks` pool.
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
