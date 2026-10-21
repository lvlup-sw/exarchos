// @ts-check
/**
 * @fileoverview The shared ESLint configuration. It is rule-only, with no recommended set.
 *
 * It carries three groups of rules:
 * - Windows portability: two `no-restricted-syntax` selectors for patterns that break on Windows.
 * - Gate config reads: under `src/verbs/gates/`, three more selectors ban the throwing config loader.
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
import commentProse from './tools/eslint-rules/comment-prose.js';
import { LINT_GLOBS, LINT_IGNORES } from './tools/audit/lib/lint-scope.mjs';

/** The `no-restricted-syntax` selectors for patterns that break on Windows. Every linted file gets them. */
const WINDOWS_PORTABILITY_SELECTORS = [
  {
    /**
     * A bare package-manager name passed to `execFile` or `execFileSync`. `execFile` spawns
     * without a shell, so it cannot launch the `.cmd` shim on Windows.
     */
    selector:
      "CallExpression[callee.name=/^execFile(Sync)?$/][arguments.0.value=/^(npm|npx|pnpm|yarn|corepack)$/]",
    message:
      'Spawn package managers via runCommandSync() (src/utils/process.ts): execFile cannot launch a .cmd shim on Windows (#1623).',
  },
  {
    /**
     * On Windows, `new URL(import.meta.url).pathname` gives `/D:/…`, and `path.resolve`
     * then gives `D:\D:\…`.
     */
    selector:
      "MemberExpression[property.name='pathname'][object.type='NewExpression'][object.callee.name='URL'][object.arguments.0.property.name='url'][object.arguments.0.object.property.name='meta']",
    message:
      'Use fileURLToPath(import.meta.url), not new URL(import.meta.url).pathname (#1620).',
  },
];

/** The message of each selector that bans the throwing config loader in a gate module. */
const GATE_CONFIG_READ_MESSAGE =
  'A gate reads .exarchos.yml with loadExarchosConfigOutcome(), so a file that does not load is never read as no file.';

/**
 * The selectors that ban `loadExarchosConfig` in a gate module. That loader throws on a file that does not load,
 * and a gate that catches the throw reads a broken file as no file. A gate reads `loadExarchosConfigOutcome`.
 * The selectors match a named import, a member access such as `config.loadExarchosConfig`, and a destructured
 * property such as `const { loadExarchosConfig } = await import(...)`.
 */
const GATE_CONFIG_READ_SELECTORS = [
  { selector: "ImportSpecifier[imported.name='loadExarchosConfig']", message: GATE_CONFIG_READ_MESSAGE },
  { selector: "MemberExpression[property.name='loadExarchosConfig']", message: GATE_CONFIG_READ_MESSAGE },
  { selector: "ObjectPattern > Property[key.name='loadExarchosConfig']", message: GATE_CONFIG_READ_MESSAGE },
];

export default [
  { ignores: [...LINT_IGNORES] },
  {
    files: [...LINT_GLOBS],
    languageOptions: {
      parser: tseslint.parser,
    },
    /**
     * With the typescript-eslint plugin, the `@typescript-eslint/*` disable directives name a known
     * rule. None of its rules are on, so `linterOptions` turns off the report of unused directives.
     */
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      comments: {
        rules: {
          'comment-content': commentContent,
          'comment-placement': commentPlacement,
          'comment-prose': commentProse,
          'comment-baseline': commentBaseline,
        },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'comments/comment-content': 'error',
      'comments/comment-placement': 'error',
      'comments/comment-prose': 'error',
      'comments/comment-baseline': 'error',
      'no-restricted-syntax': ['error', ...WINDOWS_PORTABILITY_SELECTORS],
    },
  },
  {
    /**
     * A later block replaces the options of a rule, so the gate block repeats the Windows selectors.
     * The glob covers each extension that the lint scope reads.
     */
    files: ['src/verbs/gates/**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': ['error', ...WINDOWS_PORTABILITY_SELECTORS, ...GATE_CONFIG_READ_SELECTORS],
    },
  },
];
