/**
 * StrykerJS configuration for the mutation-adequacy runner.
 *
 * A plain `stryker run` uses it for an opt-in full-tree run. The `.exarchos.yml` `mutation:` entry
 * runs `tools/audit/core/stryker-adapter.mjs`, which adds `--mutate <globs>` from the diff. That
 * flag overrides the `mutate` array below.
 *
 * StrykerJS has no cap on mutants, so the adapter fails a diff of more than `MAX_MUTATE_FILES` files.
 * `concurrency` and `timeoutMS` bound the time per worker and per mutant. `thresholds.break` stays
 * unset, because the mutation-adequacy handler scores the JSON report, not the Stryker exit code.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['json'],
  jsonReporter: {
    /** The StrykerJS default path. The adapter reads this file after the run and prints it to stdout. */
    fileName: 'reports/mutation/mutation.json',
  },
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.type-test.ts', '!src/**/*.d.ts'],
  concurrency: 4,
  timeoutMS: 10_000,
};
