import { defineConfig, configDefaults } from 'vitest/config';
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
    // The default 5 s per-test / per-hook budget is comfortable on Linux but
    // too tight on the windows-latest runner, where filesystem + better-sqlite3
    // + process-spawn latency is several times higher — a handful of otherwise-
    // healthy tests time out there (#1620). 20 s gives that headroom without
    // masking a genuine hang (which still fails, just later). No effect on the
    // Linux suite: fast tests finish in milliseconds and never reach the cap.
    testTimeout: 60000,
    hookTimeout: 60000,
    include: [
      'src/**/*.test.ts',
      // `*.type-test.ts` files carry compile-time type assertions whose real
      // gate is `tsc --noEmit` (their `.type-test.ts` name deliberately dodges
      // the tsconfig `**/*.test.ts` exclude so tsc *does* check them). Vitest
      // strips types, so these files only anchor a trivial runtime `expect`;
      // include them so they are still discoverable when run explicitly.
      'src/**/*.type-test.ts',
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
    // The composed-path Stryker smoke test (DR-7, task 012) is heavy — it
    // spawns the real pinned Stryker binary over an isolated fixture repo
    // (seconds of wall-time) — so it is excluded from the DEFAULT/coverage run.
    // That keeps it from inflating the coverage-measured lane (DR-5) and from
    // being conscripted onto the Windows leg's known spawn-flake class. It runs
    // instead in its own dedicated Linux-only test-mcp step, which sets
    // EXARCHOS_SMOKE_ONLY=1 to lift the exclusion for that one invocation
    // (vitest's CLI `--exclude` is additive and cannot un-exclude, so the
    // toggle has to live here). `configDefaults.exclude` is always preserved so
    // the node_modules/dist defaults are never dropped.
    exclude:
      process.env.EXARCHOS_SMOKE_ONLY === '1'
        ? [...configDefaults.exclude]
        : [...configDefaults.exclude, 'src/verbs/stryker-adapter.smoke.test.ts'],
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
      // `json-summary` emits `coverage/coverage-summary.json` (per-file +
      // `total` aggregate metrics). Without it the non-regression ratchet
      // (`scripts/check-coverage-ratchet.mjs`, DR-5) has no artifact to read —
      // the reporter set is the load-bearing prerequisite the ratchet's
      // fail-closed missing-summary path exists to catch.
      reporter: ['text', 'json', 'json-summary', 'html'],
      // vitest's own default is `reportOnFailure: false` — the coverage report
      // (including `coverage-summary.json`) is SKIPPED whenever any test
      // fails. This repo carries a known set of local-only red tests
      // (`project_local_only_red_baseline`), so leaving the default would
      // mean the summary artifact silently never materializes locally, and
      // would starve the ratchet of its input on any red CI run too. Force
      // the report to always be written so a missing summary is a genuine
      // reporter/tooling failure, never an artifact of unrelated red tests.
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/bench/**/*.bench.ts', 'src/index.ts', 'src/__tests__/**', 'src/types.ts']
    }
  },
  benchmark: {
    include: ['src/**/*.bench.ts'],
    outputJson: 'benchmark-results.json',
  },
});
