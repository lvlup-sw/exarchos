import { posix } from 'node:path';
import type { Success, TestInput, TestKind } from '../../contract/schemas.js';

type VitestInput = Extract<TestInput, { framework: 'vitest' }>;

export function emitVitest(input: VitestInput, kind: TestKind): Success {
  const { path, bindingModule } = input.target;
  const relative = posix.relative(posix.dirname(path), bindingModule).replace(/\.ts$/, '.js');
  const specifier = relative.startsWith('../') ? relative : `./${relative}`;
  const bindings = kind === 'property' ? 'isValid, observe, predicate' : 'isValid, observe, transform, relation';
  const check = kind === 'property'
    ? `  const observed = await observe(input);
  expect(await predicate(input, observed)).toBe(true);`
    : `  const follow = await transform([...input]);
  if (!Array.isArray(follow) || follow.length !== input.length
    || !Array.from(follow).every((value) => typeof value === 'bigint' && value >= -(1n << 63n) && value < (1n << 63n))
    || isValid(follow) !== true) {
    throw new Error('TestGen invalid case: follow-up is outside the declared domain.');
  }
  if (input.every((value, index) => value === follow[index])) {
    throw new Error('TestGen invalid case: transformation produced an identical input.');
  }
  const sourceResult = await observe(input);
  const followResult = await observe(follow);
  expect(await relation(input, follow, sourceResult, followResult)).toBe(true);`;
  const methods = input.cases.map((values, index) => `it('Case_${index + 1}', async () => {
  const input = [${values.map((value) => `${value}n`).join(', ')}];
  if (isValid(input) !== true) throw new Error('TestGen invalid case: source is outside the declared domain.');
${check}
});`);
  const lines = [
    "import { expect, it } from 'vitest';",
    `import { ${bindings} } from ${JSON.stringify(specifier)};`,
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
