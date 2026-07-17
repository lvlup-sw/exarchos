/**
 * StrykerJS configuration — the DR-7 mutation-adequacy runner substrate
 * (docs/specs/2026-07-17-wave-s-enforcement-substrate.md §DR-7, task 012).
 *
 * Consumed two ways:
 *   - Directly by `stryker run` (no CLI overrides) for a full-tree run — the
 *     long-running offline/nightly lane (DR-6 `scope:'full'`, opt-in only).
 *   - By `scripts/stryker-adapter.mjs`, the seam the `.exarchos.yml`
 *     `mutation:` entry resolves to. The adapter appends `--mutate <globs>`
 *     computed from the diff for the inline diff-scoped lane (DR-7); that
 *     CLI flag overrides the `mutate` array below for a diff-scoped run.
 *     See the adapter's header comment for the full seam rationale (the
 *     stdout-vs-file report mismatch, `--since` not being a StrykerJS flag,
 *     and the `npx`-can't-see-local-bin problem it absorbs).
 *
 * Runtime budget (documented per DR-7's acceptance criteria):
 *   - Diff-scoped CI runs are bounded by the adapter's own file-count cap
 *     (`MAX_MUTATE_FILES` in stryker-adapter.mjs) — at most 40 changed,
 *     still-existing, mutatable `src/**` files are ever passed to
 *     `--mutate` in one run. That is the practical stand-in for a "mutant
 *     count bound": StrykerJS has no native flag to cap the total mutant
 *     count directly, so the bound is enforced upstream, on the input file
 *     set, before Stryker ever runs.
 *   - `concurrency` and `timeoutMS` below additionally bound worst-case
 *     wall-clock per worker / per mutant so a busy or small CI runner can't
 *     turn a bounded file set into an unbounded run.
 *   - `vitest.related` (the vitest-runner default, left untouched) narrows
 *     each mutant's test run to the tests covering the mutated file's
 *     module graph via Vitest's `--related`, so a diff-scoped run stays
 *     fast regardless of how large the rest of the server test suite is.
 *   - Expected budget for a typical diff-scoped PR run: well under 5
 *     minutes. A full-tree run (`scope:'full'`, offline-only) carries no
 *     such bound and is intentionally excluded from the inline/CI-blocking
 *     lane (DR-7's CI wiring is diff-scoped only; full-tree stays out of
 *     scope for this slice).
 *
 * `thresholds.break` is deliberately left unset (null, the StrykerJS
 * default): pass/fail is decided by the mutation-adequacy handler's own
 * two-knob scoring (task 001's `aggregate()` over `killed`/`survived`/
 * `noCoverage`), not by Stryker's own exit code — `defaultRunMutation`
 * (mutation-adequacy.ts) folds a non-zero exit with a parseable stdout
 * report into a usable run, so Stryker's exit code is not the contract;
 * the JSON report is.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['json'],
  jsonReporter: {
    // This is StrykerJS's own default path, spelled out explicitly here
    // because it is a load-bearing part of the adapter contract (DR-7): the
    // adapter reads exactly this file after `stryker run` completes and
    // echoes its content to stdout for `defaultRunMutation` to parse.
    fileName: 'reports/mutation/mutation.json',
  },
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.type-test.ts', '!src/**/*.d.ts'],
  concurrency: 4,
  timeoutMS: 10_000,
};
