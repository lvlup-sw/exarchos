import ts from 'typescript';
import { expect, it } from 'vitest';
import { dispatch } from '../../../src/testgen/index.js';
import { typescriptReduction } from '../../../src/testgen/emitters/vitest/reduction.js';
import { inDomain, canonicalJson } from '../../../src/testgen/domains/schema.js';
import type { Domain, JsonValue } from '../../../src/testgen/domains/schema.js';
import { sample, seededRandom } from '../../../src/testgen/domains/generate.js';

const request = {
  contractVersion: 2, framework: 'vitest', frameworkVersion: '3.2.7',
  target: { path: 'tests/generated.test.ts', bindingModule: 'tests/binding.ts' },
  propertyRef: 'example/threshold', assumptions: [],
  domain: { kind: 'integer', min: '0', max: '100' }, cases: ['100'],
};

function materialize(maxAttempts: number, observe: (value: string) => number) {
  const result = dispatch('generate_property_tests', { ...request, reduction: { maxAttempts } });
  if (!result.ok) throw new Error(result.error.message);
  const source = result.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1)).filter((line) => !line.startsWith('import ')).join('\n');
  const javascript = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const tests: Array<() => Promise<void>> = [];
  const records: string[] = [];
  const execute = new Function('it', 'expect', 'console', 'observe', 'predicate', 'isValid', javascript);
  execute((_name: string, test: () => Promise<void>) => tests.push(test), expect,
    { error: (message: string) => records.push(message) }, observe,
    (_value: string, actual: number) => actual === 0, (value: string) => Number(value) >= 5);
  return { test: tests[0]!, records };
}

it('reduces a failure while rejecting out-of-domain candidates and preserving the signature', async () => {
  const { test, records } = materialize(64, (value) => Number(value) >= 17 ? 1 : 0);
  await expect(test()).rejects.toThrow(/oracle returned false/);
  const replay = JSON.parse(records[0]!.replace('TESTGEN_REPLAY ', ''));
  expect(replay).toMatchObject({ cases: ['17'], original: '100', signature: 'property/oracle-false', reduction: { aborted: null, exhausted: false } });
  expect(replay.reduction.rejected).toBeGreaterThan(0);
  expect(replay.reduction.attempts).toBeLessThanOrEqual(64);
});

it('bounds native reduction and reports exhaustion', async () => {
  const { test, records } = materialize(2, (value) => Number(value) >= 17 ? 1 : 0);
  await expect(test()).rejects.toThrow(/oracle returned false/);
  expect(JSON.parse(records[0]!.replace('TESTGEN_REPLAY ', '')))
    .toMatchObject({ cases: ['50'], reduction: { attempts: 2, rejected: 1, exhausted: true } });
});

it('retains the original assertion failure when a candidate crashes for another reason', async () => {
  const { test, records } = materialize(64, (value) => {
    if (value === '50') throw new Error('unrelated candidate crash');
    return 1;
  });
  await expect(test()).rejects.toThrow(/oracle returned false/);
  expect(JSON.parse(records[0]!.replace('TESTGEN_REPLAY ', '')))
    .toMatchObject({ cases: ['100'], signature: 'property/oracle-false', reduction: { aborted: 'Error: unrelated candidate crash' } });
});

it('shrinks compound values without leaving structural domains', () => {
  const code = ts.transpile(typescriptReduction, { target: ts.ScriptTarget.ES2022 });
  const shrink = new Function(`${code}; return smallerValues;`)() as (domain: Domain, value: JsonValue) => Generator<JsonValue>;
  const domains: Domain[] = [
    { kind: 'integer', min: '-99999999999999999999', max: '99999999999999999999' },
    { kind: 'number', min: -1e308, max: 1e308 },
    { kind: 'string', alphabet: '😀éa', minLength: 1, maxLength: 6 },
    { kind: 'array', minLength: 1, maxLength: 4, element: { kind: 'enum', values: ['a', 'b', 'c'] } },
    { kind: 'record', fields: { flag: { kind: 'boolean' }, text: { kind: 'nullable', value: { kind: 'enum', values: ['a', 'b'] } } } },
  ];
  const random = seededRandom(73);
  for (const domain of domains) {
    for (let index = 0; index < 20; index++) {
      const value = sample(domain, random);
      for (const candidate of shrink(domain, value)) {
        expect(inDomain(domain, candidate)).toBe(true);
        expect(canonicalJson(candidate)).not.toBe(canonicalJson(value));
      }
    }
  }
});
