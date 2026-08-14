// @ts-check
import tseslint from 'typescript-eslint';

/**
 * Minimal, SCOPED ESLint config — Windows-portability rules only (#1623).
 *
 * This repo does not use ESLint for general linting (it relies on `tsc`, vitest,
 * and the custom `scripts/check-*` / `lint:*` scanners). This config exists for
 * ONE purpose: give in-editor + autofix-adjacent feedback on the two
 * single-AST-node Windows anti-patterns, as the shift-left complement to the CI
 * grep-gate (`tools/audit/gates/check-windows-portability.mjs`, which also owns the
 * cross-file handle-leak heuristic that a single-node rule can't express).
 *
 * Deliberately rule-only — NO recommended ruleset — so it never flags
 * pre-existing code; it forbids exactly the two patterns below and nothing else.
 */
export default [
  {
    // Seeded-defect corpus fixtures (#1675, task 003) are INTENTIONALLY broken
    // template assets — type/lint-violation defect content materialized into
    // disposable worktrees at gate-run time, NEVER compiled/linted here. Ignore
    // the whole tree so a deliberately malformed fixture cannot fail repo CI.
    // (The tsconfig `exclude` keeps tsc off it too.)
    ignores: ['tools/evals/evals/benchmarks/seeded-defects/fixtures/**'],
  },
  {
    // Widened by task 042 to follow task 018a's extraction. Widening reach takes
    // BOTH this key and the `lint` script's CLI glob — the glob bounds the run
    // regardless of what the config admits, so changing one alone leaves the
    // other silently in charge.
    files: ['src/**/*.ts', 'tools/conformance/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    // Register the typescript-eslint plugin so the existing inline
    // `// eslint-disable @typescript-eslint/…` directives resolve to a known
    // rule — none of its rules are enabled here. Don't flag those directives as
    // "unused" just because we keep their rules off.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // execFile(Sync)('npm'|'npx'|'pnpm'|'yarn'|'corepack', …) — bare
          // package-manager name. execFile spawns without a shell, so the
          // `.cmd` shim won't launch on Windows.
          selector:
            "CallExpression[callee.name=/^execFile(Sync)?$/][arguments.0.value=/^(npm|npx|pnpm|yarn|corepack)$/]",
          message:
            'Spawn package managers via runCommandSync() (src/utils/process.ts): execFile cannot launch a .cmd shim on Windows (#1623).',
        },
        {
          // new URL(import.meta.url).pathname — yields `/D:/…` on Windows,
          // which path.resolve doubles to `D:\D:\…`.
          selector:
            "MemberExpression[property.name='pathname'][object.type='NewExpression'][object.callee.name='URL'][object.arguments.0.property.name='url'][object.arguments.0.object.property.name='meta']",
          message:
            'Use fileURLToPath(import.meta.url), not new URL(import.meta.url).pathname (#1620).',
        },
      ],
    },
  },
];
