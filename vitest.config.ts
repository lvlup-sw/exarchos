import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Captured eval ARTIFACTS live under a run dir (`tests/evals/**/runs/<task>__<arm>__r<rep>/`)
// and include agent-authored `*.test.ts` / `test.ts` files that are verbatim records,
// not project tests (they use a module-load harness with `process.exit`, not
// describe/it). Excluding the RUN dirs keeps that intent durable so no future glob
// change can collect them (and their `process.exit` can never reach a worker). The
// eval GRADERS themselves (e.g. `tests/evals/quality-ab/grade.ts`) do ship genuine
// vitest tests directly beside the grader (never under `runs/`); those are collected
// by the `unit` project's `tests/evals/**/*.test.ts` include below.
//
// The glob is keyed on `runs/` at any depth rather than on the eval tree, because
// this exclusion is what stands between a `process.exit` and a vitest worker: task
// 033 moved these artifacts out of `docs/`, and a `docs/`-anchored exclusion would
// have gone vacuous at exactly the moment the files it protects arrived somewhere
// the test globs actually reach.
const EXCLUDE = [...configDefaults.exclude, '**/runs/**'];

// `vitest bench` is a separate mode. A `benchmark.include` on the root `test`
// block is not inherited by projects — each project falls back to
// `**/*.{bench,benchmark}.ts` and then tries to load EventStore benches
// without the `bun:sqlite` alias (unit/acceptance) or with the process
// preflight that requires `exarchos` on PATH. Only `core` has the alias and
// the benches that write `benchmark-results.json`.
const CORE_BENCHES = [
  'src/**/*.bench.ts',
  'tests/unit/**/*.bench.ts',
  'tools/evals/bench/**/*.bench.ts',
];

// Windows headroom on every tier budget (#1699).
//
// The budgets below are calibrated on Linux, where spawning is cheap: all ten
// tests in `src/skills-guard.test.ts` finish in 423ms TOTAL. On the 2-core
// Windows runner two of those same tests take 5290ms and 10045ms EACH, because
// `git` spawn there costs one to two orders of magnitude more. A budget that is
// generous on Linux is therefore marginal on Windows, and marginal budgets fail
// by lottery rather than by fault: #1699 records a different victim set on
// every run — `preflight`, `compiler`, `sandbox`, `generate-legacy-skill-hashes`,
// `skills-guard` — always a timeout, never an assertion.
//
// Scaling the TIER rather than patching each victim is the point. The eligible
// population is "every test that spawns a child process", it grows with the
// suite, and the per-file fix has already been applied twice (`sandbox.test.ts`,
// then the #1805 case) without retiring the class. Deleting or `skipIf(win32)`-ing
// the victims is worse than either: a test skipped on the platform that can see
// the bug is a gate that guards nothing (#1694).
//
// Linux keeps the tight budgets unscaled, so a genuine hang still fails fast on
// the platform that runs most of the checks.
//
// Exported so `test/setup/vitest-config.test.ts` reads the factor rather than
// transcribing it — a second copy of this number is exactly the drifting-literal
// class the surrounding epic exists to remove. The nested `servers/exarchos-mcp`
// workspace is deliberately NOT scaled by it: that 60s was already chosen FOR
// Windows (#1620), so scaling it again would double-count the same headroom.
export const WIN32_SPAWN_HEADROOM = process.platform === 'win32' ? 6 : 1;
// Coverage and GitHub Actions recycle forked isolates while better-sqlite3
// still holds a native environment hook (Node 24 aborts:
// `(env) != nullptr`). One fork for those runs keeps the isolate alive
// until process exit, after `tests/helpers/close-sqlite.ts` has closed
// every tracked handle. Local `vitest run --project core` stays parallel.
const SERIALIZE_SQLITE_WORKERS =
  process.env.CI === 'true' || process.argv.includes('--coverage');
const tierTimeout = (linuxBudgetMs: number): number => linuxBudgetMs * WIN32_SPAWN_HEADROOM;

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // ROOT level, not inside the `core` project. Vitest reads coverage only
    // here — a `coverage` block on a project entry is silently ignored, which
    // is what had been happening: `npm run test:coverage` fell back to the
    // default reporter set, `coverage/coverage-summary.json` was never written,
    // and the BLOCKING ratchet that reads it (ci.yml, DR-5) had no artifact at
    // all. `test:coverage` runs `--project core`, so the measured scope is the
    // same one this block always described. Task 032 surfaced it: moving
    // `vitest-config.test.ts` under `tests/` put this file in a typechecked
    // program for the first time, and `coverage does not exist in type
    // ProjectConfig` was the checker reporting a live gate outage.
    coverage: {
      provider: 'v8',
      // `json-summary` emits `coverage/coverage-summary.json` (per-file +
      // `total` aggregate metrics). Without it the non-regression ratchet
      // (`tools/audit/gates/check-coverage-ratchet.mjs`, DR-5) has no artifact to
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
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/__tests__/**', 'src/types.ts'],
    },
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
          //
          // The stated tier costs are LINUX costs; `tierTimeout` scales them on
          // win32 (see WIN32_SPAWN_HEADROOM above). Note that "fast, in-memory"
          // describes the tier's intent, not every member: shell-out tests in
          // this tier are why the Windows timeouts land here.
          testTimeout: tierTimeout(5000),
          include: [
            'tests/scripts/**/*.test.ts',
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
            // Test-support modules and their self-tests (task 032, from the
            // misnamed `test/fixtures/`). This tier's policy is the `unit`
            // one because that is what collected them before the move.
            'tests/helpers/**/*.test.ts',
            // The DR-5 destination tiers whose policy is this one's. Declared
            // before the moves (029) so tasks 030-033 relocate files into a
            // tree that is already collected — the alternative is a window in
            // which a moved file is collected by nobody and passes by never
            // running, which is the exact failure DR-5 exists to prevent.
            'tests/e2e/**/*.test.ts',
            'tests/smoke/**/*.test.ts',
            'tests/migration/**/*.test.ts',
            // Task 033 landed here: the ICPC benchmark suite from the former
            // top-level `benchmarks/`, and both eval trees — the suite datasets
            // from the former `evals/` plus the eval GRADER tests (the harness
            // that scores an eval) from the former `docs/evals/`. Grader tests
            // sit directly beside their grader; the captured run artifacts they
            // score do NOT — those live under `runs/` and are excluded above.
            'tests/benchmarks/**/*.test.ts',
            'tests/evals/**/*.test.ts',
          ],
          // `tools/audit/core/**` are the core suite's own guard tests and run in
          // the `core` project at its budget, not this one.
          exclude: [...EXCLUDE],
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
          benchmark: { include: CORE_BENCHES },
          pool: 'forks',
          isolate: false,
          poolOptions: { forks: { singleFork: SERIALIZE_SQLITE_WORKERS } },
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
            // `test/core/**` holds integration tests that spawn the compiled
            // binary over real stdio transport. Kept outside `src/` so they are
            // not unit-test-adjacent and do not trigger the `bun:sqlite` alias —
            // the binary embeds the real `bun:sqlite` at runtime.
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
            // `*.type-test.ts` needs its own glob for the destination tiers
            // exactly as it does for `src/` above — five of them moved in task
            // 030 and were collected by NO project until this line existed,
            // which the per-test diff caught only because their ids vanished
            // rather than because anything went red.
            'tests/unit/**/*.type-test.ts',
            'tests/integration/**/*.type-test.ts',
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
              : [...EXCLUDE, 'tests/unit/verbs/stryker-adapter.smoke.test.ts'],
          setupFiles: ['./tests/helpers/close-sqlite.ts'],
        },
      },
      {
        test: {
          name: 'process',
          // `tests/process/**` is the DR-5 destination (task 032); declared now
          // so the move lands in a collected tree.
          include: ['tests/process/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: tierTimeout(15000),
          setupFiles: ['./tests/helpers/global.ts'],
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
          testTimeout: tierTimeout(30000),
          pool: 'forks',
          // `singleFork`, not `fileParallelism: false`. Vitest lists
          // `fileParallelism` (with `coverage` and `passWithNoTests`) among the
          // options it reads ONLY at the root, so on a project entry it was
          // inert — this tier exercises real OS and git state and has been
          // running its files concurrently the whole time, which is the thing
          // the setting was written to prevent. `poolOptions` is the
          // per-project form and does what the old line said.
          poolOptions: { forks: { singleFork: true } },
          setupFiles: ['./tests/helpers/close-sqlite.ts'],
        },
      },
      {
        test: {
          // End-to-end install acceptance. Separate from every tier above
          // because it materializes HEAD into a scratch dir and runs the real
          // installer over it — seconds of wall-time, and none of it shares
          // the working tree.
          //
          // `passWithNoTests` is deliberately ABSENT: this project exists to
          // prove the published contract still installs, and a glob that
          // matched nothing would report exactly the same green as a contract
          // that holds.
          name: 'acceptance',
          include: ['tests/acceptance/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: tierTimeout(120000),
          // The install writes into a scratch HOME and the archive step shells
          // out to git; serializing keeps those off each other's back. Same
          // correction as the `outcome` tier above — `fileParallelism` is a
          // root-only option and did nothing here.
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        // The extracted conformance suite. Its own project rather than an
        // `unit` include, because it reads and parses the subject tree and is
        // an order of magnitude slower per file than a unit test.
        //
        // `passWithNoTests` is deliberately ABSENT. This suite is the repo's
        // enforcement layer, so a glob that matches nothing must fail: a
        // conformance project that collects zero files is exactly the
        // silent-green outcome the suite exists to prevent.
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
          testTimeout: tierTimeout(30000),
          setupFiles: ['./tests/helpers/close-sqlite.ts'],
        },
      },
    ],
    // Carried from the dissolved core workspace. `bench` is a separate vitest
    // MODE, which is what "top level" was reaching for — but the option itself
    // belongs to the test config, not beside it. As a sibling of `test` it was
    // not read at all, so `vitest bench` fell back to the default include and
    // never wrote `benchmark-results.json` for the gate that consumes it.
    benchmark: {
      include: ['src/**/*.bench.ts', 'tools/evals/bench/**/*.bench.ts'],
      outputJson: 'benchmark-results.json',
    },
  },
});
