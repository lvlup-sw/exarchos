/**
 * Bindings lifted from `contract/declaration` — the declaration-kind union.
 *
 * This module imports a DR-1 contract module, so it must not import a
 * declaration store (`registry.ts`, `events/schemas.ts`). See `./README.md`.
 */
import { DECLARATION_KINDS } from '../../contract/declaration.js';
import { boundaryDerivations } from '../authority-topology.js';
import type { BoundaryDerivation } from '../authority-topology.js';

/**
 * The derivation bridges, bound to the live declaration-kind union.
 *
 * This is the census denominator for `checkTopologyTotality`: adding a
 * declaration kind upstream widens it here, which is what makes an unmodelled
 * boundary fail rather than pass unnoticed.
 */
export const BOUNDARY_DERIVATIONS: readonly BoundaryDerivation[] =
  boundaryDerivations(DECLARATION_KINDS);
