import ts from 'typescript';
import { expect, it } from 'vitest';
import { dispatch } from '../../../src/testgen/index.js';

const request = {
  contractVersion: 2, framework: 'vitest', frameworkVersion: '3.2.7',
  target: { path: 'tests/generated.test.ts', bindingModule: 'tests/binding.ts' },
  propertyRef: 'example/set-lifecycle', assumptions: [],
  operations: ['put', 'remove'].map((name) => ({ name, domain: { kind: 'enum', values: ['a', 'b'] } })),
  histories: [[{ operation: 'put', args: 'a' }, { operation: 'put', args: 'b' }, { operation: 'remove', args: 'a' }]],
  reduction: { maxAttempts: 64 },
};

function materialize(input = request, fault = false, observeThrows = false) {
  const result = dispatch('generate_stateful_tests', input);
  if (!result.ok) throw new Error(result.error.message);
  const source = result.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1)).filter((line) => !line.startsWith('import ')).join('\n');
  const javascript = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const tests: Array<() => Promise<void>> = [];
  const records: string[] = [];
  const counts = { created: 0, disposed: 0, executed: 0 };
  const bindings = {
    createModel: () => [] as string[],
    createSystem: () => { counts.created++; return new Set<string>(); },
    disposeSystem: (system: Set<string>) => { counts.disposed++; system.clear(); },
    isEnabled: (model: string[], operation: string, args: string) => operation === 'put' ? !model.includes(args) : model.includes(args),
    transition: (model: string[], operation: string, args: string) => operation === 'put' ? [...model, args] : model.filter((value) => value !== args),
    execute: (system: Set<string>, operation: string, args: string) => {
      counts.executed++;
      if (operation === 'put') system.add(args);
      else if (!fault) system.delete(args);
    },
    observe: (system: Set<string>) => {
      if (observeThrows) throw new Error('observation failed');
      return [...system].sort();
    },
    equivalent: (model: string[], observed: string[]) => JSON.stringify([...model].sort()) === JSON.stringify(observed),
  };
  const execute = new Function('it', 'expect', 'console', ...Object.keys(bindings), javascript);
  execute((_name: string, test: () => Promise<void>) => tests.push(test), expect,
    { error: (message: string) => records.push(message) }, ...Object.values(bindings));
  return { tests, records, counts };
}

it('creates a fresh model and system for each reduced history and preserves the failing operation', async () => {
  const { tests, records, counts } = materialize(request, true);
  await expect(tests[0]!()).rejects.toThrow(/model disagrees/);
  const replay = JSON.parse(records.find((record) => record.startsWith('TESTGEN_REPLAY '))!.replace('TESTGEN_REPLAY ', ''));
  expect(replay).toMatchObject({
    histories: [[{ operation: 'put', args: 'a' }, { operation: 'remove', args: 'a' }]],
    signature: 'stateful/remove/state-mismatch', reduction: { aborted: null, exhausted: false },
  });
  expect(replay.reduction.rejected).toBeGreaterThan(0);
  expect(counts.created).toBeGreaterThan(1);
  expect(counts.disposed).toBe(counts.created);
});

it('rejects explicit disabled operations and still disposes the system', async () => {
  const { tests, records, counts } = materialize({ ...request, histories: [[{ operation: 'remove', args: 'a' }]] });
  await expect(tests[0]!()).rejects.toThrow(/stateful\/precondition/);
  expect(counts).toEqual({ created: 1, disposed: 1, executed: 0 });
  expect(JSON.parse(records[0]!.replace('TESTGEN_HISTORY ', ''))).toMatchObject({ status: 'rejected', rejected: 1 });
  expect(records.some((record) => record.startsWith('TESTGEN_REPLAY'))).toBe(false);
});

it('reports generated-history exhaustion without a passing assertion', async () => {
  const generated = {
    ...request, histories: [], operations: [request.operations[1]!],
    generation: { seed: 7, count: 1, maxSteps: 2, maxAttempts: 10 },
  };
  const { tests, records, counts } = materialize(generated);
  await expect(tests[0]!()).rejects.toThrow(/generation-exhausted/);
  expect(JSON.parse(records[0]!.replace('TESTGEN_HISTORY ', '')))
    .toMatchObject({ status: 'rejected', attempts: 10, rejected: 10, exhausted: true });
  expect(counts).toEqual({ created: 1, disposed: 1, executed: 0 });
});

it('disposes after observation errors and retains the error', async () => {
  const { tests, records, counts } = materialize(request, false, true);
  await expect(tests[0]!()).rejects.toThrow('observation failed');
  expect(counts).toEqual({ created: 1, disposed: 1, executed: 0 });
  expect(records).toEqual([]);
});

it('validates operation names, argument domains, and generation budgets before emission', () => {
  for (const patch of [
    { operations: [request.operations[0], request.operations[0]] },
    { histories: [[{ operation: 'unknown', args: 'a' }]] },
    { histories: [[{ operation: 'put', args: 'unknown' }]] },
    { histories: [] },
    { generation: { seed: 1, count: 1, maxSteps: 3, maxAttempts: 2 } },
  ]) {
    let called = false;
    expect(dispatch('generate_stateful_tests', { ...request, ...patch }, () => { called = true; }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(called).toBe(false);
  }
});
