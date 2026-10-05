// Type-level assertions that `HarnessDescriptor` is pure data: no field is a function or holds one
// at any depth. A runtime value check cannot prove this, because a function-typed field with a data
// default passes it. Thus the assertions are conditional types, and a `tsc` compile of this file
// fails when a function-typed field enters the type. Vitest strips types, so the runtime `it` block
// is only an anchor.

import { describe, it, expect } from 'vitest';
import type { HarnessDescriptor, InjectionCandidate } from '../../../../src/runtime/launcher/harness-registry.js';

/**
 * `true` when `T` is a function type, or when an array element or an object property of `T` holds
 * a function at any depth. The function arm comes first. The array arm comes before the object
 * arm, because an array is also an object.
 */
type HasFunctionDeep<T> = T extends (...args: never[]) => unknown
  ? true
  : T extends readonly unknown[]
    ? HasFunctionDeep<T[number]>
    : T extends object
      ? true extends { [K in keyof T]-?: HasFunctionDeep<T[K]> }[keyof T]
        ? true
        : false
      : false;

/**
 * Resolves to `true` when `T` is pure data, and to `never` when `T` holds a function. An
 * assignment of `true` to a `never` binding is then a `tsc` error.
 */
type AssertPureData<T> = HasFunctionDeep<T> extends false ? true : never;

/**
 * The gate. When a `HarnessDescriptor` field is a function or holds one, `AssertPureData` resolves
 * to `never` and this assignment does not compile. The check includes the `injection` lists.
 */
const pureDataAssertionHolds: AssertPureData<HarnessDescriptor> = true;

/**
 * A direct pin on the injection candidate union. `HasFunctionDeep` distributes over the members
 * of `InjectionCandidate`, so a function in one member resolves this to `never`.
 */
const injectionPureDataAssertionHolds: AssertPureData<InjectionCandidate> = true;

type ExpectFn_TopLevel = HasFunctionDeep<{ f: () => void }> extends true ? true : never;
type ExpectFn_Nested = HasFunctionDeep<{ nested: { g: (x: number) => string } }> extends true
  ? true
  : never;
type ExpectFn_InArray = HasFunctionDeep<{ arr: readonly (() => void)[] }> extends true
  ? true
  : never;
type ExpectPure_Shape = HasFunctionDeep<{
  a: string;
  b: readonly string[];
  c: Record<string, string>;
}> extends false
  ? true
  : never;
/**
 * A function in one member of a discriminated union, the shape of `InjectionCandidate`.
 * `HasFunctionDeep` distributes over the union to `boolean`, so `AssertPureData` resolves to
 * `never`. The tuple wrap stops distribution over `never`, so this type is `true` only on detection.
 */
type ExpectFn_InUnionMember = [
  AssertPureData<{ kind: 'a'; x: string } | { kind: 'b'; run: () => void }>,
] extends [never]
  ? true
  : never;

/**
 * The self-test of the detector. Each `Expect*` type resolves to `true` when the detector is
 * correct, and to `never` when it is not. The tuple compiles only when all five hold, so a
 * detector that always returns `false` also fails the compile.
 */
const detectorSelfTest: [
  ExpectFn_TopLevel,
  ExpectFn_Nested,
  ExpectFn_InArray,
  ExpectPure_Shape,
  ExpectFn_InUnionMember,
] = [true, true, true, true, true];

describe('harness-registry pure-data (DR-4)', () => {
  /** A runtime anchor only. The guarantee is the set of module-level type assignments. */
  it('Registry_DescriptorPureData_CompileTimeAssertion', () => {
    expect(pureDataAssertionHolds).toBe(true);
    expect(injectionPureDataAssertionHolds).toBe(true);
    expect(detectorSelfTest).toEqual([true, true, true, true, true]);
  });
});
