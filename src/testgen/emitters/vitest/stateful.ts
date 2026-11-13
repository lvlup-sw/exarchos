import { posix } from 'node:path';
import type { Scenario, StatefulInput } from '../../contract/stateful.js';
import { typescriptDomainCheck } from '../shared/domain-check.js';
import { typescriptReduction } from './reduction.js';

type Input = Extract<StatefulInput, { framework: 'vitest' }>;

export function emitStatefulVitest(input: Input, scenarios: Scenario[]): string {
  const relative = posix.relative(posix.dirname(input.target.path), input.target.bindingModule).replace(/\.ts$/, '.js');
  const specifier = relative.startsWith('../') ? relative : `./${relative}`;
  const checks = input.operations.map(({ name, domain }) => `    case ${JSON.stringify(name)}: return ${typescriptDomainCheck(domain)};`).join('\n');
  const cases = scenarios.map((scenario, index) => `it('Case_${index + 1}', async () => {
  await runScenario(JSON.parse(${JSON.stringify(JSON.stringify(scenario))}), 'Case_${index + 1}');
});`).join('\n\n');
  return `import { expect, it } from 'vitest';
import { createModel, createSystem, disposeSystem, isEnabled, transition, execute, observe, equivalent } from ${JSON.stringify(specifier)};

type Step = { operation: string; args: unknown };
type Scenario = { mode: 'exact' | 'enabled'; steps: Step[]; requiredSteps: number };
type Result = {
  status: 'pass' | 'fail' | 'rejected'; signature: string; history: Step[];
  attempts: number; rejected: number; exhausted: boolean;
};
const operations: Array<{ name: string; domain: ShrinkDomain }> = JSON.parse(${JSON.stringify(JSON.stringify(input.operations))});
const domains = new Map(operations.map(operation => [operation.name, operation.domain]));
${typescriptReduction}
function validArguments(operation: string, value: unknown): boolean {
  switch (operation) {
${checks}
    default: return false;
  }
}

async function checkHistory(scenario: Scenario): Promise<Result> {
  let model = await createModel();
  const system = await createSystem();
  const history: Step[] = [];
  let attempts = 0;
  let rejected = 0;
  const result = (status: Result['status'], signature = '', exhausted = false): Result =>
    ({ status, signature, history, attempts, rejected, exhausted });
  try {
    const initial = await equivalent(model, await observe(system));
    if (initial === false) return result('fail', 'stateful/initial-state');
    if (initial !== true) throw new Error('TestGen equivalence binding must return a boolean.');
    for (const step of scenario.steps) {
      if (history.length === scenario.requiredSteps) break;
      attempts++;
      if (!validArguments(step.operation, step.args)) return result('rejected', 'stateful/invalid-arguments');
      const enabled = isEnabled(model, step.operation, structuredClone(step.args));
      if (enabled !== true && enabled !== false) throw new Error('TestGen precondition must return a synchronous boolean.');
      if (!enabled) {
        rejected++;
        if (scenario.mode === 'exact') return result('rejected', 'stateful/precondition');
        continue;
      }
      model = await transition(model, step.operation, structuredClone(step.args));
      await execute(system, step.operation, structuredClone(step.args));
      history.push(structuredClone(step));
      const matches = await equivalent(model, await observe(system));
      if (matches === false) return result('fail', 'stateful/' + step.operation + '/state-mismatch');
      if (matches !== true) throw new Error('TestGen equivalence binding must return a boolean.');
    }
    if (history.length !== scenario.requiredSteps) return result('rejected', 'stateful/generation-exhausted', true);
    return result('pass');
  } finally {
    await disposeSystem(system);
  }
}

function* smallerHistories(history: Step[]): Generator<Step[]> {
  yield* shorterArrays(history, 0);
  for (let index = 0; index < history.length; index++) {
    const step = history[index]!;
    const domain = domains.get(step.operation)!;
    for (const args of smallerValues(domain, step.args)) {
      const candidate = structuredClone(history);
      candidate[index] = { operation: step.operation, args };
      yield candidate;
    }
  }
}

async function runScenario(scenario: Scenario, caseId: string): Promise<void> {
  const original = await checkHistory(scenario);
  console.error('TESTGEN_HISTORY ' + JSON.stringify({ version: 2, propertyRef: ${JSON.stringify(input.propertyRef)}, caseId, ...original }));
  if (original.status === 'pass') return;
  if (original.status === 'rejected') throw new Error('TestGen invalid history: ' + original.signature);
  let current = original.history;
  const seen = new Set([JSON.stringify(current)]);
  let attempts = 0;
  let rejected = 0;
  let duplicates = 0;
  let aborted: string | null = null;
  const maximum = ${input.reduction?.maxAttempts ?? 0};
  let changed = true;
  while (changed && attempts < maximum && aborted === null) {
    changed = false;
    for (const candidate of smallerHistories(current)) {
      if (attempts >= maximum) break;
      attempts++;
      const key = JSON.stringify(candidate);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      try {
        const checked = await checkHistory({ mode: 'exact', steps: candidate, requiredSteps: candidate.length });
        if (checked.status === 'rejected') rejected++;
        if (checked.status === 'fail' && checked.signature === original.signature) {
          current = checked.history;
          changed = true;
          break;
        }
      } catch (error) { aborted = String(error); break; }
    }
  }
  console.error('TESTGEN_REPLAY ' + JSON.stringify({
    version: 2, propertyRef: ${JSON.stringify(input.propertyRef)}, method: 'stateful', caseId,
    operations, histories: [current], original: original.history, signature: original.signature,
    reduction: { attempts, rejected, duplicates, exhausted: attempts >= maximum, aborted },
  }));
  expect(original.status, 'TestGen model disagrees with the system; replay history recorded.').toBe('pass');
}

${cases}
`;
}
