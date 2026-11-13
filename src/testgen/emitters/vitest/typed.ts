import { posix } from 'node:path';
import { typescriptReduction } from './reduction.js';
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
      check: `  const observed = await observe(structuredClone(source));
  return await predicate(structuredClone(source), observed);`,
    },
    metamorphic: {
      bindings: 'isValid, observe, transform, relation',
      check: `  const follow = await transform(structuredClone(source));
  if (!inDomain(follow) || isValid(structuredClone(follow)) !== true) throw new InvalidCase('TestGen invalid case: follow-up is outside the declared domain.');
  if (canonical(source) === canonical(follow)) throw new InvalidCase('TestGen invalid case: transformation produced an identical input.');
  const before = await observe(structuredClone(source));
  const after = await observe(structuredClone(follow));
  return await relation(structuredClone(source), structuredClone(follow), before, after);`,
    },
    differential: {
      bindings: 'isValid, observe, reference, equivalent',
      check: `  const actual = await observe(structuredClone(source));
  const expected = await reference(structuredClone(source));
  return await equivalent(structuredClone(source), actual, expected);`,
    },
  };
  const selected = methods[method];
  const cases = input.cases.map((value, index) => `it('Case_${index + 1}', async () => {
  const source = JSON.parse(${JSON.stringify(canonicalJson(value))}) as Input;
  await runCase(source, 'Case_${index + 1}');
});`);
  const canonical = `
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}
`;
  return `import { expect, it } from 'vitest';
import { ${selected.bindings} } from ${JSON.stringify(specifier)};

type Input = Parameters<typeof observe>[0];
class InvalidCase extends Error {}
const domain: ShrinkDomain = JSON.parse(${JSON.stringify(JSON.stringify(input.domain))});

function inDomain(value: unknown): boolean {
  return ${typescriptDomainCheck(input.domain)};
}
${canonical}
${typescriptReduction}
async function check(source: Input): Promise<boolean> {
  if (!inDomain(source) || isValid(structuredClone(source)) !== true) throw new InvalidCase('TestGen invalid case: source is outside the declared domain.');
${selected.check}
}

async function runCase(source: Input, caseId: string): Promise<void> {
  let passed: boolean;
  try {
    passed = await check(source);
  } catch (error) {
    if (error instanceof InvalidCase) console.error('TESTGEN_REJECTED ' + JSON.stringify({ caseId, reason: error.message, cases: [source] }));
    throw error;
  }
  if (passed === true) return;
  if (passed !== false) throw new Error('TestGen binding must return a boolean verdict.');
  let current = structuredClone(source);
  const seen = new Set([canonical(current)]);
  let attempts = 0;
  let rejected = 0;
  let duplicates = 0;
  let aborted: string | null = null;
  const maximum = ${input.reduction?.maxAttempts ?? 0};
  let changed = true;
  while (changed && attempts < maximum && aborted === null) {
    changed = false;
    for (const candidate of smallerValues(domain, current)) {
      if (attempts >= maximum) break;
      attempts++;
      const key = canonical(candidate);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      if (!inDomain(candidate)) { rejected++; continue; }
      try {
        const verdict = await check(candidate as Input);
        if (verdict === false) {
          current = candidate as Input;
          changed = true;
          break;
        }
        if (verdict !== true) throw new Error('TestGen binding must return a boolean verdict.');
      } catch (error) {
        if (error instanceof InvalidCase) rejected++;
        else { aborted = String(error); break; }
      }
    }
  }
  console.error('TESTGEN_REPLAY ' + JSON.stringify({
    version: 2, propertyRef: ${JSON.stringify(input.propertyRef)}, method: ${JSON.stringify(method)},
    caseId, domain, cases: [current], original: source,
    signature: ${JSON.stringify(method + '/oracle-false')},
    reduction: { attempts, rejected, duplicates, exhausted: attempts >= maximum, aborted },
  }));
  expect(passed, 'TestGen ${method} oracle returned false; replay fixture recorded.').toBe(true);
}

${cases.join('\n\n')}
`;
}
