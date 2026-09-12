// @ts-check
import tseslint from 'typescript-eslint';
import { loadPolicy } from './tools/audit/lib/comment-policy.mjs';
import commentContent, { resolvePolicyPath } from './tools/eslint-rules/comment-content.js';

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
 *
 * It also carries `comments/comment-content`, which was written to be loaded
 * here and never was. Its own header describes itself as the edit-time half of
 * a pair whose other half is a CI gate — and that gate does not exist either:
 * the datum's `exemptPaths` still name `scripts/check-comment-*.mjs`, a path
 * with no file behind it. So a policy with ten forbidden patterns, a
 * classifier, a fixture corpus and two test suites enforced NOTHING, and an
 * `INV-1` sat in a linted file through green lint runs until a human found it.
 *
 * The standing backlog is 9,288 findings over 1,212 files — a decade of
 * planning ordinals, and every remedy is a rewrite only the comment's author
 * can judge. So it is recorded per file in
 * `tools/audit/comment-content-suppressions.json` rather than fixed here or
 * waved through. A new violation fails, an extra one in an already-recorded
 * file fails, and a FIXED one fails too until its suppression is pruned —
 * which is what makes that file shrink-only rather than a place to hide.
 *
 *   npx eslint <the lint script's globs> --suppressions-location \
 *     tools/audit/comment-content-suppressions.json --prune-suppressions
 *
 * `envelopes/no-handler-throw` is deliberately NOT here. It has its own
 * type-aware `eslint.envelopes.config.js`, wired into CI as `lint:envelopes`,
 * and that config says in its own words that it is never the shared one. Its
 * suppressions live off the default path for the same reason: a file at
 * `eslint-suppressions.json` is read by EVERY eslint invocation in the repo,
 * which turned that green gate red until this one was moved aside.
 */

/**
 * The comment policy's own exemptions, read from the datum rather than copied.
 *
 * A kill fixture carries verbatim offender text and the datum spells the
 * patterns it forbids, so both must be out of this rule's reach — and both
 * already say so, with reasons, in `exemptPaths`. Restating them here would be
 * the second authority the rule's header explicitly refuses.
 *
 * They are turned OFF for this rule rather than ignored outright, so the
 * Windows-portability rules keep running over the same files, and so the rule
 * itself stays a pure classifier: its kill probe runs the offender corpus
 * through it by path, which a rule that self-exempted could not do.
 *
 * Resolved through the RULE's own `resolvePolicyPath`, not `loadPolicy`'s
 * default. The rule honours `EXARCHOS_COMMENT_POLICY` and falls back
 * module-relative when the working directory is not the repository root. A
 * second resolver here would scope the rule by one datum while the rule
 * classified by another — exempt files still linted, non-exempt files
 * silently excused.
 */
const commentPolicyExemptions = loadPolicy(resolvePolicyPath()).exemptPaths.map(
  (entry) => entry.glob,
);

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
    // Widened by task 042 from `tools/conformance/src` to the whole `tools/`
    // tree, following task 036's consolidation. Widening reach takes BOTH this
    // key and the `lint` script's CLI glob — the glob bounds the run regardless
    // of what the config admits, and this key decides which of those files get
    // a configuration at all. Change one alone and the other is silently in
    // charge: before this, `eslint tools/audit/**` reported 38 files "ignored
    // because no matching configuration was supplied" and exited 0.
    //
    // Findings over the newly-linted directories were MEASURED before the
    // widening rather than assumed: zero. That is a property of this ruleset
    // being narrow (one `no-restricted-syntax` rule), not a general licence to
    // widen without looking.
    //
    // Widened again to `tests/**` when `comments/comment-content` was wired in
    // below. Measured the same way first: 4,127 comment findings over 664 test
    // files, and ZERO new `no-restricted-syntax` findings, so the existing
    // rules gain reach at no cost. Leaving the test tree out would have left
    // open the exact hole that prompted this — a planning-artifact path in
    // `tests/helpers/preflight.ts` that a human reviewer caught because no
    // lint run could see the file.
    files: ['src/**/*.ts', 'tools/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    // Register the typescript-eslint plugin so the existing inline
    // `// eslint-disable @typescript-eslint/…` directives resolve to a known
    // rule — none of its rules are enabled here. Don't flag those directives as
    // "unused" just because we keep their rules off.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      comments: { rules: { 'comment-content': commentContent } },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'comments/comment-content': 'error',
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
  {
    files: commentPolicyExemptions,
    rules: { 'comments/comment-content': 'off' },
  },
];
