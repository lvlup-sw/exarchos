import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
          ],
        },
      },
      {
        test: {
          name: 'process',
          include: ['test/process/**/*.test.ts'],
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
          testTimeout: 30000,
          fileParallelism: false,
          passWithNoTests: true,
        },
      },
    ],
  },
});
