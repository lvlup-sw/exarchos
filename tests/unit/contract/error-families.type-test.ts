import { it, expect } from 'vitest';
import {
  FAMILY_DEFAULTS,
  STABLE_ERROR_REGISTRY,
  type FailureLayer,
  type FailureFamilyDescriptor,
  type StableErrorSpec,
  type ContractExitCode,
} from '../../../src/contract/error-families.js';

// ─── Compile-time totality proofs (the real gate is `tsc --noEmit`) ──────────
//
// These `.type-test.ts` assertions fail the TypeScript build — not vitest — if
// the error-family contract ever loses totality. The trivial runtime `it`
// below only anchors the file so it is discoverable when run explicitly.

/**
 * Proof 1 — an unmapped family cannot exist. `FAMILY_DEFAULTS` is typed as
 * `Record<FailureLayer, …>`, so this exact-shape reconstruction requires every
 * layer key. Adding a 7th `FailureLayer` without a descriptor here is a
 * compile error (TS2741 missing property).
 */
const _everyLayerMapped: Record<FailureLayer, FailureFamilyDescriptor> = FAMILY_DEFAULTS;
void _everyLayerMapped;

/**
 * Proof 2 — a family descriptor's `exitCode` is a `ContractExitCode`, so a
 * family can never be given an exit code outside the stable table.
 */
type _ExitIsContractExit = (typeof FAMILY_DEFAULTS)[FailureLayer]['exitCode'] extends ContractExitCode
  ? true
  : never;
const _exitProof: _ExitIsContractExit = true;
void _exitProof;

/**
 * Proof 3 — every stable-registry entry structurally satisfies
 * {@link StableErrorSpec} with a `FailureLayer`. A code assigned a bogus layer
 * (e.g. a typo) fails to compile.
 */
type _RegistryIsWellTyped = typeof STABLE_ERROR_REGISTRY extends Readonly<
  Record<string, StableErrorSpec>
>
  ? true
  : never;
const _registryProof: _RegistryIsWellTyped = true;
void _registryProof;

/**
 * Proof 4 — every registered code's `layer` is a member of the `FailureLayer`
 * union (no orphan layer strings).
 */
type _RegistryLayers = (typeof STABLE_ERROR_REGISTRY)[keyof typeof STABLE_ERROR_REGISTRY]['layer'];
type _LayersAreClosed = _RegistryLayers extends FailureLayer ? true : never;
const _layersProof: _LayersAreClosed = true;
void _layersProof;

it('error-families type-test anchor', () => {
  expect(true).toBe(true);
});
