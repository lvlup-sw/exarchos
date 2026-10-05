/**
 * Vitest configuration for the root suite and its tier projects.
 *
 * The vitest host mints `EXARCHOS_TEST_RUN_ID` once, and every forked worker inherits it.
 * `tests/helpers/hermetic-install-identity.ts` names its per-run scratch state with it. A host pid
 * cannot name a run, because a later host can get the same pid and reuse stale scratch state. Tests
 * in workers also import this file, so the assignment uses `??=` and the inherited value wins.
 */
import { defineConfig, configDefaults } from 'vitest/config';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Excludes every captured eval run directory (`runs/`) at any depth. A run holds agent-authored
 * `*.test.ts` records that call `process.exit` and are not project tests. The glob keys on `runs/`,
 * not on the eval tree, so the exclusion holds wherever the artifacts live. Grader tests sit beside
 * their grader, outside `runs/`, and the `unit` project collects them.
 */
const EXCLUDE = [...configDefaults.exclude, '**/runs/**'];

/**
 * Bench globs for the `core` project. A project does not inherit a root `benchmark.include`. Without
 * its own list, a project falls back to the default bench glob and loads benches it cannot run.
 */
const CORE_BENCHES = [
  'src/**/*.bench.ts',
  'tests/unit/**/*.bench.ts',
  'tools/evals/bench/**/*.bench.ts',
];

/**
 * Windows headroom factor for the tier budgets (#1699). The budgets are calibrated on Linux, where a
 * `git` spawn is cheap. On the 2-core Windows runner a spawn costs one to two orders of magnitude
 * more, so a tight budget fails by timeout at random. The factor scales the whole tier, because the
 * set of tests that spawn a child process grows with the suite. Linux stays unscaled, so a real
 * hang still fails fast. Tests import this value and keep no copy of the number.
 */
export const FILE_BOUNDARY_RESET = './tests/helpers/reset-process-state.ts';

export const CLOSE_SQLITE = './tests/helpers/close-sqlite.ts';

const HERMETIC_INSTALL_IDENTITY = './tests/helpers/hermetic-install-identity.ts';

export const WIN32_SPAWN_HEADROOM = process.platform === 'win32' ? 6 : 1;
const tierTimeout = (linuxBudgetMs: number): number => linuxBudgetMs * WIN32_SPAWN_HEADROOM;

process.env['EXARCHOS_TEST_RUN_ID'] ??= `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

/**
 * Loaded by every project. It yields to the event loop before and after each
 * test. Thus synchronous work cannot add up across tests and block the worker
 * past the 60 s RPC timeout of vitest (#2029).
 */
const YIELD_BETWEEN_TESTS = './tests/helpers/yield-between-tests.ts';

/**
 * The global setup that gives each run one temp root and removes it at the end.
 * It is declared on the root config, which vitest runs for every project. Thus
 * every worker of every project inherits the root through TMPDIR, TEMP and TMP.
 */
export const TEMP_RUN_ROOT_SETUP = './tools/test-helpers/temp-run-root.ts';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    /**
     * This file configures coverage at the root, because vitest ignores a `coverage` block on a
     * project. `test:coverage` runs `--project core`. The blocking coverage ratchet in `ci.yml`
     * reads the summary that this block writes.
     */
    globalSetup: [TEMP_RUN_ROOT_SETUP],
    coverage: {
      provider: 'v8',
      /**
       * `json-summary` writes `coverage/coverage-summary.json`, which
       * `tools/audit/gates/check-coverage-ratchet.mjs` reads.
       */
      reporter: ['text', 'json', 'json-summary', 'html'],
      /**
       * By default, vitest skips the coverage report when a test fails. This repo has known
       * local-only red tests, so vitest always writes the report. Then a missing summary means a
       * tooling failure.
       */
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/__tests__/**', 'src/types.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          setupFiles: [FILE_BOUNDARY_RESET, HERMETIC_INSTALL_IDENTITY, YIELD_BETWEEN_TESTS],
          /**
           * Each root project states its own `testTimeout`. `tierTimeout` scales a Linux budget for
           * win32. The include leaves out `src/**`, because the `core` project collects those tests
           * at its own budget.
           */
          testTimeout: tierTimeout(5000),
          include: [
            'tests/scripts/**/*.test.ts',
            /** Black-box tests that run the git-hook samples in `tools/git-hooks/` with `sh`. */
            'tools/git-hooks/**/*.test.ts',
            'tests/architecture/**/*.test.ts',
            /** Test-support modules and their self-tests. */
            'tests/helpers/**/*.test.ts',
            'tests/e2e/**/*.test.ts',
            'tests/smoke/**/*.test.ts',
            'tests/migration/**/*.test.ts',
            /**
             * The ICPC benchmark suite. The eval glob below collects the eval grader tests beside
             * their graders. `EXCLUDE` leaves out the captured run artifacts under `runs/`.
             */
            'tests/benchmarks/**/*.test.ts',
            'tests/evals/**/*.test.ts',
          ],
          exclude: [...EXCLUDE],
        },
      },
      {
        resolve: {
          alias: {
            /**
             * `bun:sqlite` resolves only under Bun, and vitest runs under Node. So the import
             * resolves to a shim over `better-sqlite3`. The compiled binary still imports the real
             * `bun:sqlite`.
             */
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
          /**
           * The 60s budget covers the slower filesystem, SQLite, and process spawns on the Windows
           * runner (#1620). `WIN32_SPAWN_HEADROOM` does not scale it, because it already covers
           * Windows. A real hang still fails, only later.
           */
          testTimeout: 60000,
          hookTimeout: 60000,
          include: [
            'src/**/*.test.ts',
            /**
             * `*.type-test.ts` files hold compile-time type assertions that `tsc --noEmit` checks.
             * The name does not end in `.test.ts`, so the tsconfig exclude of test files does not
             * apply and tsc reads them.
             * Vitest collects them so that an explicit run finds them.
             */
            'src/**/*.type-test.ts',
            'tests/core/**/*.test.ts',
            /**
             * Product core tests outside `src/`. They keep this project policy, because the
             * `bun:sqlite` alias and the 60s budget belong to the code under test.
             */
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            /** The test tiers need their own `*.type-test.ts` globs, as `src/` does. */
            'tests/unit/**/*.type-test.ts',
            'tests/integration/**/*.type-test.ts',
            /**
             * The eval and test-helper suites under `tools/`. Without these globs, no project
             * collects them.
             */
            'tools/evals/**/*.test.ts',
            'tools/test-helpers/**/*.test.ts',
            'tools/evals/bench/**/*.bench.ts',
          ],
          /**
           * The default run excludes the Stryker smoke test, because it spawns the real Stryker
           * binary and takes seconds. A Linux-only CI step sets `EXARCHOS_SMOKE_ONLY=1` to collect
           * it. The toggle lives here, because the vitest `--exclude` flag can only add exclusions.
           */
          exclude:
            process.env.EXARCHOS_SMOKE_ONLY === '1'
              ? [...EXCLUDE]
              : [...EXCLUDE, 'tests/unit/verbs/stryker-adapter.smoke.test.ts'],
          setupFiles: [FILE_BOUNDARY_RESET, HERMETIC_INSTALL_IDENTITY, CLOSE_SQLITE, YIELD_BETWEEN_TESTS],
        },
      },
      {
        test: {
          name: 'process',
          include: ['tests/process/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: tierTimeout(15000),
          setupFiles: [
            FILE_BOUNDARY_RESET,
            HERMETIC_INSTALL_IDENTITY,
            './tests/helpers/global.ts',
            YIELD_BETWEEN_TESTS,
          ],
        },
      },
      {
        /**
         * The outcome tier exercises real OS state: CLI binaries, git, and MCP handlers. It needs
         * the `bun:sqlite` alias, because the SQLite backend of the MCP server imports `bun:sqlite`.
         */
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
          /**
           * `singleFork` runs the files one at a time. Vitest reads `fileParallelism` only at the
           * root, so `poolOptions` is the project-level form.
           */
          poolOptions: { forks: { singleFork: true } },
          setupFiles: [FILE_BOUNDARY_RESET, HERMETIC_INSTALL_IDENTITY, CLOSE_SQLITE, YIELD_BETWEEN_TESTS],
        },
      },
      {
        resolve: {
          alias: {
            /**
             * The acceptance suites use `src/storage/sqlite-backend.ts`, which imports `bun:sqlite`.
             * This lane runs under Node, so it uses the same shim alias as the `core`, `outcome` and
             * `conformance` projects.
             */
            'bun:sqlite': fileURLToPath(
              new URL('./src/storage/__shims__/bun-sqlite-node.ts', import.meta.url),
            ),
          },
        },
        test: {
          /**
           * End-to-end install acceptance. It writes HEAD into a scratch directory and runs the real
           * installer. `passWithNoTests` stays unset, because a glob that matches nothing must fail.
           */
          name: 'acceptance',
          include: ['tests/acceptance/**/*.test.ts'],
          setupFiles: [FILE_BOUNDARY_RESET, HERMETIC_INSTALL_IDENTITY, CLOSE_SQLITE, YIELD_BETWEEN_TESTS],
          exclude: EXCLUDE,
          testTimeout: tierTimeout(120000),
          /**
           * `singleFork` runs the files one at a time, so the scratch HOME installs and the git
           * archive steps do not overlap.
           */
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        /**
         * The extracted conformance suite. It reads and parses the subject tree, so it is much
         * slower per file than a unit test. `passWithNoTests` stays unset, because a glob that
         * matches nothing must fail.
         */
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
          setupFiles: [FILE_BOUNDARY_RESET, HERMETIC_INSTALL_IDENTITY, CLOSE_SQLITE, YIELD_BETWEEN_TESTS],
        },
      },
    ],
    /**
     * The bench options belong inside `test`, because vitest does not read a `benchmark` sibling of
     * `test`. `vitest bench` writes `benchmark-results.json` for the gate that reads it.
     */
    benchmark: {
      include: ['src/**/*.bench.ts', 'tools/evals/bench/**/*.bench.ts'],
      outputJson: 'benchmark-results.json',
    },
  },
});
