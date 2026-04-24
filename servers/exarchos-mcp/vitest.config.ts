import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // `bun:sqlite` is a virtual module that only resolves under Bun.
      // Vitest runs under Node, so we redirect the import to a thin shim
      // over `better-sqlite3` for the duration of test execution. The
      // compiled binary (produced by `bun build --compile`) still imports
      // the real `bun:sqlite` at runtime — this alias is test-only.
      'bun:sqlite': fileURLToPath(
        new URL('./src/storage/__shims__/bun-sqlite-node.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    include: [
      'src/**/*.test.ts',
      'scripts/**/*.test.ts',
      // `test/process/**` holds PR1 integration tests that spawn the
      // compiled binary over real stdio transport (task 1.6). Kept outside
      // `src/` so they are not unit-test-adjacent and do not trigger the
      // `bun:sqlite` alias — the binary embeds the real `bun:sqlite` at
      // runtime.
      'test/**/*.test.ts',
      // `tests/**` holds golden-fixture integration tests (T052, DR-15)
      // that replay canonical event streams and assert document shape.
      // Separate from `test/` so fixture files live alongside the tests
      // without conflicting with the compiled-binary integration suite.
      'tests/**/*.test.ts',
      'src/bench/**/*.bench.ts',
    ],
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
