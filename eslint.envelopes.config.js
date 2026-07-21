// @ts-check
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import noHandlerThrow from './eslint-rules/no-handler-throw.js';

/**
 * Dedicated flat config for the error-envelope lint (#1706 DR-1/DR-2).
 *
 * DELIBERATELY separate from the shared `eslint.config.js`:
 *   - the shared config backs the FILTERED `lint:windows` step (`test-root`
 *     in CI), which must stay a fast, non-type-aware, single-AST-node config
 *     (#1623). Loading a type-aware rule there would silently convert that
 *     filtered step into a type-checked run and let it evaluate a rule the
 *     filtered lane was never meant to carry.
 *   - this config is invoked ONLY by `scripts/lint-envelopes.mjs` (task 002)
 *     on the UNFILTERED `grep-gates` lane — the two-surface hosting rule in
 *     `docs/guides/ci-gate-hosting.md`.
 *
 * The lint glob is scoped to `servers/exarchos-mcp/src/orchestrate/**` — the
 * registration-set surface (`composite.ts` owns `ACTION_HANDLERS` + the six
 * special-cased branches) — to bound the type-aware run's cost (the #1721
 * whole-tree OOM class). `parserOptions.project` points at the MCP server's
 * own tsconfig: the type checker still resolves cross-file handler symbols
 * (e.g. a handler imported from `../tasks/tools.js`) transitively through
 * its full dependency closure regardless of this glob — only the NUMBER OF
 * FILES ESLint itself iterates (and produces diagnostics for) is bounded by
 * `files` below, which is what keeps the run bounded.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    // Test files are excluded from the MCP tsconfig's `include` (see
    // servers/exarchos-mcp/tsconfig.json), so they are not part of the
    // `ts.Program` `parserOptions.project` builds below — linting them here
    // would error with "file not in project". They carry no ACTION_HANDLERS
    // registration surface anyway.
    ignores: ['servers/exarchos-mcp/src/orchestrate/**/*.test.ts'],
  },
  {
    files: ['servers/exarchos-mcp/src/orchestrate/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './servers/exarchos-mcp/tsconfig.json',
        tsconfigRootDir: HERE,
      },
    },
    plugins: {
      envelopes: { rules: { 'no-handler-throw': noHandlerThrow } },
    },
    rules: {
      'envelopes/no-handler-throw': 'error',
    },
  },
);
