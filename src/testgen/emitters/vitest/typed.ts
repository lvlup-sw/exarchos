import { posix } from 'node:path';
import type { TypedInput, TypedMethod } from '../../contract/typed.js';
import { canonicalJson } from '../../domains/schema.js';
import { typescriptDomainCheck } from '../shared/domain-check.js';

type Input = Extract<TypedInput, { framework: 'vitest' }>;

export function emitTypedVitest(input: Input, method: TypedMethod): string {
  const relative = posix.relative(posix.dirname(input.target.path), input.target.bindingModule).replace(/\.ts$/, '.js');
  const specifier = relative.startsWith('../') ? relative : `./${relative}`;
  const methods = {
    property: {
      bindings: 'isValid, observe, predicate',
      check: `  const observed = await observe(source);
  expect(await predicate(source, observed)).toBe(true);`,
    },
    metamorphic: {
      bindings: 'isValid, observe, transform, relation',
      check: `  const follow = await transform(structuredClone(source));
  if (!inDomain(follow) || isValid(follow) !== true) throw new Error('TestGen invalid case: follow-up is outside the declared domain.');
  if (canonical(source) === canonical(follow)) throw new Error('TestGen invalid case: transformation produced an identical input.');
  const before = await observe(source);
  const after = await observe(follow);
  expect(await relation(source, follow, before, after)).toBe(true);`,
    },
    differential: {
      bindings: 'isValid, observe, reference, equivalent',
      check: `  const actual = await observe(structuredClone(source));
  const expected = await reference(structuredClone(source));
  expect(await equivalent(source, actual, expected)).toBe(true);`,
    },
  };
  const selected = methods[method];
  const cases = input.cases.map((value, index) => `it('Case_${index + 1}', async () => {
  const source = JSON.parse(${JSON.stringify(canonicalJson(value))});
  if (!inDomain(source) || isValid(source) !== true) throw new Error('TestGen invalid case: source is outside the declared domain.');
${selected.check}
});`);
  const canonical = method === 'metamorphic' ? `
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}
` : '';
  return `import { expect, it } from 'vitest';
import { ${selected.bindings} } from ${JSON.stringify(specifier)};

function inDomain(value: unknown): boolean {
  return ${typescriptDomainCheck(input.domain)};
}
${canonical}
${cases.join('\n\n')}
`;
}
