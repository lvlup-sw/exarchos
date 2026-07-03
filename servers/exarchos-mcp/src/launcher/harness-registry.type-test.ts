// ─── Harness Descriptor: pure-data compile-time assertion (DR-4) ─────────────
//
// The load-bearing gate. `HarnessDescriptor` must be *pure data* — no field may
// be, or (recursively) contain, a function. That invariant cannot be trusted to
// a runtime value sample: a future function-valued field with a data default
// would pass a value check. So it is pinned here as a **conditional type** that
// fails `tsc --noEmit` the moment a function-typed field is introduced.
//
// This file is named `*.type-test.ts` (not `*.test.ts`) deliberately: that name
// dodges the tsconfig `**/*.test.ts` exclude, so `tsc` DOES compile — and thus
// gate on — the assertions below. Vitest strips types, so the runtime `it`
// block is only a thin anchor; a green `tsc` is the real guarantee.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { HarnessDescriptor } from './harness-registry.js';

/**
 * `true` iff `T` is a function type, or (recursively) any of its array elements
 * or object properties is/contains a function. `false` for pure primitive /
 * array-of-primitive / record-of-primitive shapes.
 *
 * Order matters: the function arm is first, and the array arm precedes the
 * object arm (arrays are structurally objects too).
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
 * Resolves to `true` when `T` is pure data, and to `never` when it contains a
 * function — assigning a `true` value to a `never`-typed binding is the `tsc`
 * error that turns "someone added a behavior hook" into a build failure.
 */
type AssertPureData<T> = HasFunctionDeep<T> extends false ? true : never;

// ── THE GATE ─────────────────────────────────────────────────────────────────
// If any HarnessDescriptor field becomes (or nests) a function, `AssertPureData`
// collapses to `never` and this assignment fails `tsc --noEmit`.
const pureDataAssertionHolds: AssertPureData<HarnessDescriptor> = true;

// ── Detector self-test (defends against a no-op HasFunctionDeep) ──────────────
// Each `_Expect*` resolves to `true` only if the detector behaves; to `never`
// otherwise. The tuple assignment compiles only when all four hold — so a
// weakened detector (e.g. one that always returns `false`) also fails the build,
// not just a mutated descriptor.
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

const detectorSelfTest: [
  ExpectFn_TopLevel,
  ExpectFn_Nested,
  ExpectFn_InArray,
  ExpectPure_Shape,
] = [true, true, true, true];

describe('harness-registry pure-data (DR-4)', () => {
  it('Registry_DescriptorPureData_CompileTimeAssertion', () => {
    // Runtime anchor only. The guarantee is the two module-level type
    // assignments above, which `tsc --noEmit` gates on. If either type
    // regresses, the build fails before this test ever runs.
    expect(pureDataAssertionHolds).toBe(true);
    expect(detectorSelfTest).toEqual([true, true, true, true]);
  });
});
