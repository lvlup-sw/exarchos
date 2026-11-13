import type { StatefulInput, StatefulSuccess } from './stateful.js';
import { generateHistories } from '../generators/histories.js';
import { emitStatefulVitest } from '../emitters/vitest/stateful.js';
import { emitStatefulTUnit } from '../emitters/tunit/stateful.js';

export function emitStateful(input: StatefulInput): StatefulSuccess {
  const scenarios = generateHistories(input);
  const source = input.framework === 'vitest' ? emitStatefulVitest(input, scenarios) : emitStatefulTUnit(input, scenarios);
  const lines = source.trimEnd().split('\n');
  const path = input.target.path;
  return {
    ok: true, contractVersion: 2,
    generatorVersion: input.framework === 'vitest' ? 'vitest/stateful-1' : 'tunit/stateful-1',
    patch: [
      `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), '',
    ].join('\n'),
    fixture: { version: 2, operations: input.operations, scenarios },
    propertyRefs: [input.propertyRef], assumptions: input.assumptions,
    unresolvedObligations: [
      'Review model independence, reset and disposal, observation boundaries, and operation preconditions.',
      'Compile and execute the native suite, confirm discovery, and challenge assertions with a controlled lifecycle defect.',
      'Generated candidate pools are filtered by model preconditions during native execution. Exhaustion reports an invalid history.',
      'Sequential model checks cover ordered operations. Concurrency, durability, and liveness require separate evidence.',
    ],
    validation: input.framework === 'vitest'
      ? { executable: 'npm', args: ['exec', '--no', '--', 'vitest', 'run', path] }
      : { executable: 'dotnet', args: ['run', '--project', input.target.project, '-c', 'Release'] },
  };
}
