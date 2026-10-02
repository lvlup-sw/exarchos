/**
 * Bindings for `contract/declaration`: the declaration-kind union.
 *
 * This module imports a contract module. The declaration-seam rule then forbids an
 * import of a declaration store (`registry.ts`, `events/schemas.ts`).
 */
import { DECLARATION_KINDS } from '../../../../src/contract/declaration.js';
import { boundaryDerivations } from '../authority-topology.js';
import type { BoundaryDerivation } from '../authority-topology.js';

/**
 * The derivation bridges, bound to the live declaration-kind union.
 *
 * This is the denominator for `checkTopologyTotality`. A new declaration kind widens it,
 * so a boundary with no model fails the check.
 */
export const BOUNDARY_DERIVATIONS: readonly BoundaryDerivation[] =
  boundaryDerivations(DECLARATION_KINDS);
