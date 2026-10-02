/** Support-level helper for the runtime adapters. `types.ts` holds the `SupportLevel` contract. */

import { Capability } from '../capabilities.js';
import type { SupportLevel } from './types.js';

/** Build a support level for each `Capability` value: the override when one exists, else `defaultLevel`. */
export function buildSupportMap(
  defaultLevel: SupportLevel,
  overrides: Partial<Record<Capability, SupportLevel>> = {},
): Readonly<Record<Capability, SupportLevel>> {
  const result = {} as Record<Capability, SupportLevel>;
  for (const cap of Capability.options) {
    result[cap] = overrides[cap] ?? defaultLevel;
  }
  return result;
}
