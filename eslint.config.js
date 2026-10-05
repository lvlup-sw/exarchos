// @ts-check
/**
 * @fileoverview The shared ESLint configuration. It is rule-only, with no recommended set.
 *
 * It carries two groups of rules:
 * - Windows portability: two `no-restricted-syntax` selectors for patterns that break on Windows.
 * - Comment governance: the `comments/*` rules, which read `.exarchos/comment-policy.json` and the
 *   baseline at `tools/audit/comment-quality/baseline.tsv`. Each rule checks its own exemptions.
 *
 * The scope comes from `tools/audit/lib/lint-scope.mjs`. The `lint` script and this file both
 * use it. CI runs this configuration through `npm run lint:comments`. The envelope rule has its
 * own type-aware configuration in `eslint.envelopes.config.js`.
 */
import tseslint from 'typescript-eslint';
import commentContent from './tools/eslint-rules/comment-content.js';
import commentBaseline from './tools/eslint-rules/comment-baseline.js';
import commentPlacement from './tools/eslint-rules/comment-placement.js';
import { LINT_GLOBS, LINT_IGNORES } from './tools/audit/lib/lint-scope.mjs';

export default [
  { ignores: [...LINT_IGNORES] },
  {
    files: [...LINT_GLOBS],
    languageOptions: {
      parser: tseslint.parser,
    },
    // Register the typescript-eslint plugin so the existing inline
    // `// eslint-disable @typescript-eslint/…` directives resolve to a known
    // rule — none of its rules are enabled here. Don't flag those directives as
    // "unused" just because we keep their rules off.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      comments: {
        rules: { 'comment-content': commentContent, 'comment-placement': commentPlacement, 'comment-baseline': commentBaseline },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'comments/comment-content': 'error',
      'comments/comment-placement': 'error',
      'comments/comment-baseline': 'error',
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
