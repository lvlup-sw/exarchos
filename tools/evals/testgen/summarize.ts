import { readFileSync } from 'node:fs';
import { z } from 'zod';

const arms = ['ordinary', 'skill', 'tools'] as const;
const baseline = ['valid-pass', 'invalid', 'build-failure', 'false-failure', 'timeout', 'infrastructure-error'] as const;
const control = ['assertion-kill', 'survived', 'build-failure', 'timeout', 'infrastructure-error', 'unrun'] as const;
const seconds = z.number().nonnegative().nullable();

const input = z.strictObject({
  controls: z.array(z.string().min(1)).min(1),
  trials: z.array(z.strictObject({
    id: z.string().min(1),
    arm: z.enum(arms),
    baseline: z.enum(baseline),
    controls: z.record(z.string(), z.enum(control)),
    generationSeconds: seconds,
    executionSeconds: seconds,
    reviewSeconds: seconds,
    shrinkingSeconds: seconds,
    replay: z.enum(['passed', 'failed', 'unrun']),
    retainedTests: z.number().int().nonnegative(),
  })),
});

const path = process.argv[2];
if (!path) throw new Error('Usage: bun tools/evals/testgen/summarize.ts <trial-results.json>');
const data = input.parse(JSON.parse(readFileSync(path, 'utf8')));
const unique = (values: readonly string[]) => new Set(values).size === values.length;
if (!unique(data.controls) || !unique(data.trials.map(({ id }) => id))) {
  throw new Error('Control names and trial IDs must be unique.');
}

for (const trial of data.trials) {
  if (Object.keys(trial.controls).length !== data.controls.length ||
      data.controls.some((id) => !Object.hasOwn(trial.controls, id))) {
    throw new Error(`Trial ${trial.id} must account for every control, including unrun controls.`);
  }
  if (trial.baseline !== 'valid-pass' && Object.values(trial.controls).includes('assertion-kill')) {
    throw new Error(`Trial ${trial.id} cannot claim an assertion kill without a valid baseline pass.`);
  }
}

const summary = arms.map((arm) => {
  const trials = data.trials.filter((trial) => trial.arm === arm);
  return {
    arm,
    attempted: trials.length,
    baseline: Object.fromEntries(baseline.map((status) => [
      status, trials.filter((trial) => trial.baseline === status).length,
    ])),
    controls: Object.fromEntries(data.controls.map((id) => [
      id, Object.fromEntries(control.map((status) => [
        status, trials.filter((trial) => trial.controls[id] === status).length,
      ])),
    ])),
    retainedTests: trials.reduce((count, trial) => count + trial.retainedTests, 0),
    observations: trials.map(({ id, generationSeconds, executionSeconds, reviewSeconds, shrinkingSeconds, replay }) =>
      ({ id, generationSeconds, executionSeconds, reviewSeconds, shrinkingSeconds, replay })),
  };
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
