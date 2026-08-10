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
const tierTimeout = (linuxBudgetMs: number): number => linuxBudgetMs * WIN32_SPAWN_HEADROOM;

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          // Root-package unit tests only. Tests under `servers/exarchos-mcp/`
          // are owned by that workspace's own `vitest.config.ts` (which sets up
          // the `bun:sqlite` alias and resolves `@fast-check/vitest` from the
          // nested `node_modules/`). CI runs them via `cd servers/exarchos-mcp
          // && npm run test:run`.
          //
          // Explicit per-tier timeout policy (WFQ-015): every root project
          // states its own `testTimeout` rather than leaning on vitest's
          // implicit 5000ms default, so the timeout policy is legible and
          // uniform across the tiers — unit (fast, in-memory) 5s < process
          // (spawns real processes) 15s < outcome (real OS/git/CLI state) 30s.
          // The nested `servers/exarchos-mcp` workspace pins a higher 60s for
          // Windows headroom on its integration suite; both workspaces now run
          // vitest (see test-runtime-resolver bun `test:run` honoring), so each
          // honors its declared vitest timeout rather than a native runner's.
          //
          // The stated tier costs are LINUX costs; `tierTimeout` scales them on
          // win32 (see WIN32_SPAWN_HEADROOM above). Note that "fast, in-memory"
          // describes the tier's intent, not every member: `src/skills-guard.test.ts`
          // and `scripts/**` shell out to `git`, which is why this tier is where
          // the Windows timeouts land.
          testTimeout: tierTimeout(5000),
          include: [
            'src/**/*.test.ts',
            'benchmarks/**/*.test.ts',
            'scripts/**/*.test.ts',
            // Black-box tests for top-level git-hook samples (e.g. the opt-in
            // pre-push ship-gate hook). They drive the `.sample` script via
            // `sh` and assert exit codes — no MCP-package deps, so they run in
            // the root `unit` project rather than `servers/exarchos-mcp`.
            'hooks/**/*.test.ts',
            'test/fixtures/**/*.test.ts',
            'test/setup/**/*.test.ts',
            'test/migration/**/*.test.ts',
            'test/smoke/**/*.test.ts',
            'test/e2e/**/*.test.ts',
            // Eval GRADER tests (the harness that scores an eval), directly beside
            // the grader — NOT the captured run artifacts (those stay under
            // `runs/`, excluded above). e.g. `docs/evals/quality-ab/grade.test.ts`.
            'docs/evals/**/*.test.ts',
          ],
          exclude: EXCLUDE,
        },
      },
      {
        test: {
          name: 'process',
          include: ['test/process/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: tierTimeout(15000),
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
              new URL(
                './servers/exarchos-mcp/src/storage/__shims__/bun-sqlite-node.ts',
                import.meta.url,
              ),
            ),
          },
        },
        test: {
          name: 'outcome',
          include: ['tests/outcome/**/*.test.ts'],
          exclude: EXCLUDE,
          testTimeout: tierTimeout(30000),
          fileParallelism: false,
          passWithNoTests: true,
        },
      },
    ],
  },
});
