import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { dispatch } from '../../../src/testgen/index.js';

const request = JSON.parse(readFileSync(new URL('../../support/testgen/vitest-metamorphic.json', import.meta.url), 'utf8'));

function generatedCase(bindings: Record<string, unknown>): () => Promise<void> {
  const result = dispatch('generate_metamorphic_tests', { ...request, cases: [['1']] });
  if (!result.ok) throw new Error(result.error.message);
  const source = result.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1)).filter((line) => !line.startsWith('import ')).join('\n');
  const cases: Array<() => Promise<void>> = [];
  const register = (_name: string, body: () => Promise<void>) => cases.push(body);
  const compile = new Function('it', 'expect', ...Object.keys(bindings), source);
  compile(register, expect, ...Object.values(bindings));
  expect(cases).toHaveLength(1);
  return cases[0]!;
}

it('executes both observations and detects a false relation with async bindings', async () => {
  const observe = vi.fn(async ([value]: bigint[]) => value);
  const relation = vi.fn(async (_source: bigint[], _follow: bigint[], before: bigint, after: bigint) => after === -before);
  const test = generatedCase({ isValid: () => true, transform: async ([value]: bigint[]) => [-value!], observe, relation });
  await test();
  expect(observe.mock.calls).toEqual([[[1n]], [[-1n]]]);
  relation.mockResolvedValueOnce(false);
  await expect(test()).rejects.toThrow(/expected false to be true/);
});

it.each([null, [], new Array<bigint>(1), [1n], [1], [1n << 63n], [-(1n << 63n) - 1n]].map((follow) => ({ follow })))(
  'rejects invalid or identical follow-up case %# before observing the target', async ({ follow }) => {
    const observe = vi.fn();
    const test = generatedCase({ isValid: () => true, transform: () => follow, observe, relation: () => true });
    await expect(test()).rejects.toThrow('TestGen invalid case:');
    expect(observe).not.toHaveBeenCalled();
  },
);

it('rejects a follow-up that violates the supplied precondition', async () => {
  const observe = vi.fn();
  const test = generatedCase({
    isValid: ([value]: bigint[]) => value! > 0n,
    transform: () => [-1n], observe, relation: () => true,
  });
  await expect(test()).rejects.toThrow('follow-up is outside the declared domain');
  expect(observe).not.toHaveBeenCalled();
});

it('requires a synchronous true precondition before observing the target', async () => {
  const observe = vi.fn();
  const test = generatedCase({ isValid: async () => false, transform: () => [-1n], observe, relation: () => true });
  await expect(test()).rejects.toThrow('source is outside the declared domain');
  expect(observe).not.toHaveBeenCalled();
});
