import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Captured eval ARTIFACTS live under a run dir (`docs/evals/**/runs/<task>__<arm>__r<rep>/`)
// and include agent-authored `*.test.ts` / `test.ts` files that are verbatim records,
// not project tests (they use a module-load harness with `process.exit`, not
// describe/it). Excluding the RUN dirs keeps that intent durable so no future glob
// change can collect them (and their `process.exit` can never reach a worker). The
// eval GRADERS themselves (e.g. `docs/evals/quality-ab/grade.ts`) do ship genuine
// vitest tests directly beside the grader (never under `runs/`); those are collected
// by the `unit` project's explicit `docs/evals/**/*.test.ts` include below.
const EXCLUDE = [...configDefaults.exclude, 'docs/**/runs/**'];

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          // Root-package unit tests only. Everything under `src/` now belongs to
          // the `core` project below — task 019 folded the MCP server's tree
          // into `src/`, so the glob that used to mean "the installer toolchain"
          // would otherwise sweep ~1,560 core tests into this tier's 5s budget.
          // That is exactly the Windows-lottery failure task 011 declared
          // unacceptable (#1620), so `src/**` is deliberately absent here.
          //
          // Explicit per-tier timeout policy (WFQ-015): every root project
          // states its own `testTimeout` rather than leaning on vitest's
          // implicit 5000ms default, so the timeout policy is legible and
          // uniform across the tiers — unit (fast, in-memory) 5s < process
          // (spawns real processes) 15s < outcome (real OS/git/CLI state) 30s
          // < core (Windows headroom on a real filesystem + SQLite) 60s.
          testTimeout: 5000,
          include: [
            'benchmarks/**/*.test.ts',
            'scripts/**/*.test.ts',
            // Black-box tests for top-level git-hook samples (e.g. the opt-in
            // pre-push ship-gate hook). They drive the `.sample` script via
            // `sh` and assert exit codes — no MCP-package deps, so they run in
            // the root `unit` project rather than `servers/exarchos-mcp`.
            'tools/git-hooks/**/*.test.ts',
            // Structural oracles captured before the six-directory move
            // (baseline, test inventory, guard liveness, reference census).
            // They are authored at their POST-move home so the move does not
            // have to touch them, which means this include is what keeps them
            // running in the meantime — without it they are collected by no
            // project and pass by never executing.
            'tests/architecture/**/*.test.ts',
            'test/fixtures/**/*.test.ts',
            'test/setup/**/*.test.ts',
            'test/migration/**/*.test.ts',
            'test/smoke/**/*.test.ts',
            'test/e2e/**/*.test.ts',
            // The DR-5 destination tiers whose policy is this one's. Declared
            // before the moves (029) so tasks 030-033 relocate files into a
            // tree that is already collected — the alternative is a window in
            // which a moved file is collected by nobody and passes by never
            // running, which is the exact failure DR-5 exists to prevent.
            'tests/e2e/**/*.test.ts',
            'tests/smoke/**/*.test.ts',
            'tests/migration/**/*.test.ts',
            'tests/benchmarks/**/*.test.ts',
            'tests/evals/**/*.test.ts',
            // Eval GRADER tests (the harness that scores an eval), directly beside
            // the grader — NOT the captured run artifacts (those stay under
            // `runs/`, excluded above). e.g. `docs/evals/quality-ab/grade.test.ts`.
            'docs/evals/**/*.test.ts',
          ],
          // `scripts/core/**` are the core suite's own guard tests and run in
          // the `core` project at its budget, not this one.
          exclude: [...EXCLUDE, 'scripts/core/**'],
        },
      },
      {
        // The product core (task 019). Formerly the `servers/exarchos-mcp`
        // workspace with its own vitest.config.ts; the package dissolved but
        // its POLICY did not, because the policy is load-bearing and was chosen
        // deliberately (task 011). Every knob below is carried over verbatim.
        resolve: {
          alias: {
            // `bun:sqlite` is a virtual module that only resolves under Bun.
            // Vitest runs under Node, so the import is redirected to a thin shim
            // over `better-sqlite3` for the duration of test execution. The
            // compiled binary (produced by `bun build --compile`) still imports
            // the real `bun:sqlite` at runtime — this alias is test-only.
            'bun:sqlite': fileURLToPath(
              new URL('./src/storage/__shims__/bun-sqlite-node.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'core',
          pool: 'forks',
          // The default 5 s per-test / per-hook budget is comfortable on Linux
          // but too tight on the windows-latest runner, where filesystem +
          // better-sqlite3 + process-spawn latency is several times higher — a
          // handful of otherwise-healthy tests time out there (#1620). This
          // headroom does not mask a genuine hang (which still fails, just
          // later), and has no effect on the Linux suite: fast tests finish in
          // milliseconds and never reach the cap. Not to be re-scaled.
          testTimeout: 60000,
          hookTimeout: 60000,
          include: [
            'src/**/*.test.ts',
            // `*.type-test.ts` files carry compile-time type assertions whose
            // real gate is `tsc --noEmit` (their `.type-test.ts` name
            // deliberately dodges the tsconfig `**/*.test.ts` exclude so tsc
            // *does* check them). Vitest strips types, so these files only
            // anchor a trivial runtime `expect`; include them so they are still
            // discoverable when run explicitly.
            'src/**/*.type-test.ts',
            'scripts/core/**/*.test.ts',
            // `test/core/**` holds integration tests that spawn the compiled
            // binary over real stdio transport. Kept outside `src/` so they are
            // not unit-test-adjacent and do not trigger the `bun:sqlite` alias —
            // the binary embeds the real `bun:sqlite` at runtime.
            'test/core/**/*.test.ts',
            // `tests/core/**` holds golden-fixture integration tests (T052,
            // DR-15) that replay canonical event streams and assert document
            // shape. Separate from `test/core/` so fixture files live alongside
            // the tests without conflicting with the compiled-binary suite.
            'tests/core/**/*.test.ts',
            // The DR-5 destination for the product core's own tests (tasks
            // 030/031). They keep THIS project's policy, not the root `unit`
            // tier's: the `bun:sqlite` alias and the 60s Windows headroom are
            // properties of the code under test, and they do not stop applying
            // because a file moved out from beside its subject.
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            // The layer map sent `evals/`, `bench/`, `benchmarks/` and
            // `test-helpers/` out of the product tree and into `tools/`. They
            // were part of this suite before the move and still are — without
            // these two globs they are collected by NO project and pass by
            // never executing, which is the failure mode the tree-move is most
            // likely to introduce and least likely to show.
            'tools/evals/**/*.test.ts',
            'tools/test-helpers/**/*.test.ts',
            'tools/evals/bench/**/*.bench.ts',
          ],
          // The composed-path Stryker smoke test (DR-7, task 012) is heavy — it
          // spawns the real pinned Stryker binary over an isolated fixture repo
          // (seconds of wall-time) — so it is excluded from the DEFAULT/coverage
          // run. That keeps it from inflating the coverage-measured lane (DR-5)
          // and from being conscripted onto the Windows leg's known spawn-flake
          // class. It runs instead in its own dedicated Linux-only test step,
          // which sets EXARCHOS_SMOKE_ONLY=1 to lift the exclusion for that one
          // invocation (vitest's CLI `--exclude` is additive and cannot
          // un-exclude, so the toggle has to live here).
          exclude:
            process.env.EXARCHOS_SMOKE_ONLY === '1'
              ? [...EXCLUDE]
              : [...EXCLUDE, 'src/verbs/stryker-adapter.smoke.test.ts'],
          coverage: {
            provider: 'v8',
            // `json-summary` emits `coverage/coverage-summary.json` (per-file +
            // `total` aggregate metrics). Without it the non-regression ratchet
            // (`scripts/check-coverage-ratchet.mjs`, DR-5) has no artifact to
            // read — the reporter set is the load-bearing prerequisite the
            // ratchet's fail-closed missing-summary path exists to catch.
            reporter: ['text', 'json', 'json-summary', 'html'],
            // vitest's own default is `reportOnFailure: false` — the coverage
            // report (including `coverage-summary.json`) is SKIPPED whenever any
            // test fails. This repo carries a known set of local-only red tests,
            // so leaving the default would mean the summary artifact silently
            // never materializes locally, and would starve the ratchet of its
            // input on any red CI run too. Force the report to always be written
            // so a missing summary is a genuine reporter/tooling failure, never
            // an artifact of unrelated red tests.
            reportOnFailure: true,
            include: ['src/**/*.ts'],
            exclude: [
              'src/**/*.test.ts',
              'src/index.ts',
              'src/__tests__/**',
              'src/types.ts',
            ],
          },
        },
      },
      {
        test: {
          name: 'process',
          // `tests/process/**` is the DR-5 destination (task 032); declared now
          // so the move lands in a collected tree.
          include: ['test/process/**/*.test.ts', 'tests/process/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: 15000,
          setupFiles: ['./test/setup/global.ts'],
        },
      },
      {
        // Outcome tier (Phase B/C of the wave1 substrate). Tests exercise
        // real OS state — CLI binaries, git, MCP handlers — and surface
        // operator-visible regressions. The `bun:sqlite` alias is needed
        // because the MCP server's SQLite backend (consumed by `EventStore`
        // and downstream handlers like `handleMergeOrchestrate`) imports
        // from `bun:sqlite`; under Node-hosted vitest we redirect to the
        // better-sqlite3 shim that the MCP workspace already ships. The
        // alias is scoped to this project so the unit/process tiers
        // remain untouched.
        resolve: {
          alias: {
            'bun:sqlite': fileURLToPath(
              new URL('./src/storage/__shims__/bun-sqlite-node.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'outcome',
          include: ['tests/outcome/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: 30000,
          fileParallelism: false,
          passWithNoTests: true,
        },
      },
      {
        test: {
          // End-to-end install acceptance (task 028). Separate from every tier
          // above because it materializes HEAD into a scratch dir and runs the
          // real installer over it — seconds of wall-time, and none of it
          // shares the working tree.
          //
          // `passWithNoTests` is deliberately ABSENT: this project exists to
          // prove the published contract still installs, and a glob that
          // matched nothing would report exactly the same green as a contract
          // that holds.
          name: 'acceptance',
          include: ['tests/acceptance/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: 120000,
          // The install writes into a scratch HOME and the archive step shells
          // out to git; serializing keeps those off each other's back.
          fileParallelism: false,
        },
      },
      {
        // The extracted conformance suite (task 018a). Its own project rather
        // than an `unit` include, because it reads and parses the subject tree
        // and is an order of magnitude slower per file than a unit test.
        //
        // `passWithNoTests` is deliberately ABSENT. This suite is the repo's
        // enforcement layer, so a glob that matches nothing must fail: a
        // conformance project that collects zero files is exactly the
        // silent-green outcome the suite exists to prevent, and this package
        // has just moved.
        // The parity fixtures task 019 routed into this package reach the
        // SQLite backend, which imports `bun:sqlite` — a virtual module that
        // resolves only under Bun. The alias travelled with neither move, so
        // those files failed to LOAD rather than failing an assertion.
        resolve: {
          alias: {
            'bun:sqlite': fileURLToPath(
              new URL('./src/storage/__shims__/bun-sqlite-node.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'conformance',
          include: ['tools/conformance/src/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: 30000,
        },
      },
    ],
  },
  // Carried from the dissolved core workspace. `bench` is a separate vitest
  // mode, not a project, so it stays at the top level.
  benchmark: {
    include: ['src/**/*.bench.ts', 'tools/evals/bench/**/*.bench.ts'],
    outputJson: 'benchmark-results.json',
  },
});
