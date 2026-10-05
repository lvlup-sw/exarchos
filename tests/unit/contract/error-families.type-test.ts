/**
 * Compile-time totality proofs for the error-family contract.
 * A proof fails as a TypeScript compile error, not as a vitest failure.
 * The proofs hold only in a `tsc` program that includes this file. `tests/tsconfig.json` excludes
 * `unit/**`, so `npm run typecheck` does not check them.
 * The runtime `it` at the end only lets vitest collect the file.
 */
import { it, expect } from 'vitest';
import {
  FAMILY_DEFAULTS,
  STABLE_ERROR_REGISTRY,
  type FailureLayer,
  type FailureFamilyDescriptor,
  type StableErrorSpec,
  type ContractExitCode,
} from '../../../src/contract/error-families.js';

/**
 * Proof 1: each layer has a family descriptor.
 * A `FailureLayer` member with no key in `FAMILY_DEFAULTS` is a compile error (TS2741).
 */
const _everyLayerMapped: Record<FailureLayer, FailureFamilyDescriptor> = FAMILY_DEFAULTS;
void _everyLayerMapped;

/** Proof 2: the `exitCode` of each family descriptor is a `ContractExitCode`. */
type _ExitIsContractExit = (typeof FAMILY_DEFAULTS)[FailureLayer]['exitCode'] extends ContractExitCode
  ? true
  : never;
const _exitProof: _ExitIsContractExit = true;
void _exitProof;

/**
 * Proof 3: each entry of the stable registry satisfies {@link StableErrorSpec}.
 * A code with a layer outside `FailureLayer` does not compile.
 */
type _RegistryIsWellTyped = typeof STABLE_ERROR_REGISTRY extends Readonly<
  Record<string, StableErrorSpec>
>
  ? true
  : never;
const _registryProof: _RegistryIsWellTyped = true;
void _registryProof;

/** Proof 4: the `layer` of each registered code is a member of the `FailureLayer` union. */
type _RegistryLayers = (typeof STABLE_ERROR_REGISTRY)[keyof typeof STABLE_ERROR_REGISTRY]['layer'];
type _LayersAreClosed = _RegistryLayers extends FailureLayer ? true : never;
const _layersProof: _LayersAreClosed = true;
void _layersProof;

it('error-families type-test anchor', () => {
  expect(true).toBe(true);
});
