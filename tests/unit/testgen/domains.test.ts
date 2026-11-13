import fc from 'fast-check';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { domainProblem, inDomain, canonicalJson } from '../../../src/testgen/domains/schema.js';
import type { Domain } from '../../../src/testgen/domains/schema.js';
import { boundaries, generateCases, sample, seededRandom } from '../../../src/testgen/domains/generate.js';
import { typescriptDomainCheck } from '../../../src/testgen/emitters/shared/domain-check.js';
import { dispatch } from '../../../src/testgen/index.js';

const domain: Domain = {
  kind: 'record',
  fields: {
    text: { kind: 'string', alphabet: 'aé😀', minLength: 0, maxLength: 4 },
    count: { kind: 'integer', min: '-99999999999999999999999', max: '99999999999999999999999' },
    score: { kind: 'number', min: -1e308, max: 1e308 },
    flags: { kind: 'array', element: { kind: 'boolean' }, minLength: 0, maxLength: 3 },
    color: { kind: 'nullable', value: { kind: 'enum', values: ['red', 'blue'] } },
  },
};
const request = {
  contractVersion: 2,
  framework: 'vitest', frameworkVersion: '3.2.7',
  propertyRef: 'example/record', assumptions: [], domain, cases: [],
  generation: { seed: 42, count: 25, maxAttempts: 100 },
  target: { path: 'tests/generated.test.ts', bindingModule: 'tests/binding.ts' },
};

it('constructs reproducible valid cases across typed domains and exact large integers', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 4294967295 }), (seed) => {
    const budget = { seed, count: 50, maxAttempts: 100 };
    const first = generateCases(domain, [], budget);
    expect(first).toEqual(generateCases(domain, [], budget));
    expect(first.cases).toHaveLength(50);
    expect(first.cases.every((value) => inDomain(domain, value))).toBe(true);
    expect(new Set(first.cases.map(canonicalJson)).size).toBe(50);
  }), { numRuns: 25 });
});

it('reports exhausted attempts and duplicates for a finite domain', () => {
  const result = generateCases({ kind: 'boolean' }, [], { seed: 0, count: 4, maxAttempts: 10 });
  expect(result).toEqual({ cases: [false, true], attempts: 10, duplicates: 8, exhausted: true });
});

it('emitted TypeScript guards agree with domain membership, including Unicode and invalid cases', () => {
  const source = `function check(value: unknown): boolean { return ${typescriptDomainCheck(domain)}; }`;
  const javascript = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const check = new Function(`${javascript}; return check;`)() as (value: unknown) => boolean;
  const valid = [...boundaries(domain), ...Array.from({ length: 30 }, () => sample(domain, seededRandom(17)))];
  for (const value of valid) {
    expect(check(value)).toBe(true);
    expect(inDomain(domain, value)).toBe(true);
  }
  const anchor = valid[0] as Record<string, unknown>;
  for (const value of [null, {}, [], { ...anchor, text: 'z' }, { ...anchor, count: '1\n' },
    { ...anchor, count: '100000000000000000000000' }, { ...anchor, score: Infinity },
    { ...anchor, flags: new Array(1) }, { ...anchor, extra: true }]) {
    expect(check(value)).toBe(false);
    expect(inDomain(domain, value)).toBe(false);
  }
});

it('rejects reversed bounds and excessive domain materialization', () => {
  expect(domainProblem({ kind: 'integer', min: '10', max: '1' })).toMatch(/reversed/);
  expect(domainProblem({ kind: 'array', minLength: 0, maxLength: 64,
    element: { kind: 'array', minLength: 0, maxLength: 64, element: { kind: 'boolean' } } })).toMatch(/budget/);
});

it.each(['property', 'metamorphic', 'differential'])('dispatches typed %s requests with preserved fixture domains', (method) => {
  const result = dispatch(`generate_${method}_tests`, request);
  expect(result).toMatchObject({ ok: true, contractVersion: 2, fixture: { version: 2, domain }, generation: { seed: 42, exhausted: false } });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.fixture.cases).toHaveLength(25);
});

it('fails input validation before emission for malformed typed requests', () => {
  for (const patch of [
    { cases: [{}] },
    { domain: { kind: 'integer', min: '2', max: '1' } },
    { cases: [], generation: undefined },
    { domain: { kind: 'boolean' }, cases: [true, true] },
    { domain: { kind: 'boolean' }, cases: [true, false], generation: { seed: 1, count: 1, maxAttempts: 10 } },
  ]) {
    let called = false;
    expect(dispatch('generate_property_tests', { ...request, ...patch }, () => { called = true; }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(called).toBe(false);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(dispatch('generate_property_tests', cyclic)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});

it('rejects oversized generated fixtures before materializing the case pool', () => {
  const request = {
    contractVersion: 2, framework: 'vitest', frameworkVersion: '3.2.7',
    target: { path: 'tests/size.test.ts', bindingModule: 'tests/binding.ts' },
    propertyRef: 'budget/size', assumptions: [], cases: [],
    domain: { kind: 'array', minLength: 0, maxLength: 64, element: { kind: 'string', alphabet: 'ab', minLength: 0, maxLength: 64 } },
    generation: { seed: 1, count: 256, maxAttempts: 256 },
  };
  expect(dispatch('generate_property_tests', request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('megabytes') } });
});

it('rejects lossy raw keys and non-scalar text before schema parsing', () => {
  const request = {
    contractVersion: 2, framework: 'vitest', frameworkVersion: '3.2.7',
    target: { path: 'tests/text.test.ts', bindingModule: 'tests/binding.ts' },
    propertyRef: 'text/exact', assumptions: [], cases: [], generation: { seed: 1, count: 1, maxAttempts: 1 },
    domain: { kind: 'boolean' },
  };
  for (const domain of [
    { kind: 'enum', values: ['\ud800'] },
    { kind: 'record', fields: { ['\ud800']: { kind: 'boolean' } } },
    JSON.parse('{"kind":"record","fields":{"__proto__":{"kind":"boolean"}}}'),
  ]) {
    expect(dispatch('generate_property_tests', { ...request, domain })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }
  expect(dispatch('generate_property_tests', { ...request, domain: { kind: 'record', fields: {} }, cases: [JSON.parse('{"__proto__":true}')] }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(dispatch('generate_property_tests', { ...request, propertyRef: '\ud800' }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(dispatch('generate_property_tests', { ...request, domain: { kind: 'enum', values: ['😀\u0085\u2028\u2029'] } }))
    .toMatchObject({ ok: true, fixture: { cases: ['😀\u0085\u2028\u2029'] } });
});
