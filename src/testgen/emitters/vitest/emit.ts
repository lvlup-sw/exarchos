import { posix } from 'node:path';
import type { Success, TestInput } from '../../contract/schemas.js';

type VitestInput = Extract<TestInput, { framework: 'vitest' }>;

export function emitVitest(input: VitestInput): Success {
  const { path, bindingModule } = input.target;
  const relative = posix.relative(posix.dirname(path), bindingModule).replace(/\.ts$/, '.js');
  const specifier = relative.startsWith('../') ? relative : `./${relative}`;
  const methods = input.cases.map((values, index) => `it('Case_${index + 1}', async () => {
  const input = [${values.map((value) => `${value}n`).join(', ')}];
  if (!isValid(input)) throw new Error('TestGen invalid case: source is outside the declared domain.');
  const observed = await observe(input);
  expect(await predicate(input, observed)).toBe(true);
});`);
  const lines = [
    "import { expect, it } from 'vitest';",
    `import { isValid, observe, predicate } from ${JSON.stringify(specifier)};`,
    '',
    methods.join('\n\n'),
  ].join('\n').split('\n');

  return {
    ok: true,
    contractVersion: 1,
    generatorVersion: 'vitest/1',
    patch: [
      `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), '',
    ].join('\n'),
    fixture: { version: 1, cases: input.cases },
    propertyRefs: [input.propertyRef],
    assumptions: input.assumptions,
    unresolvedObligations: [
      'Type-check and execute emitted cases in the target project with the reviewed bindings.',
      'Check that the native test runner discovers every case and that negative controls fail at the intended assertion.',
    ],
    validation: { executable: 'npm', args: ['exec', '--no', '--', 'vitest', 'run', path] },
  };
}
