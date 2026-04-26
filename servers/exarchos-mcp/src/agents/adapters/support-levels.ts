// ─── Support-level helpers ─────────────────────────────────────────────────
//
// Small DRY utility for adapters that share the non-Claude classification
// shape: most capabilities are native, `isolation:worktree` is advisory,
// and a small set of Claude-specific primitives (Agent Teams, signal
// hooks, session resume) are unsupported.
//
// See `types.ts` for the `SupportLevel` contract and Task 4f in
// docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { Capability } from '../capabilities.js';
import type { SupportLevel } from './types.js';

/**
 * Build a `Record<Capability, SupportLevel>` by starting from `defaultLevel`
 * and applying `overrides`. Guarantees exhaustiveness over every value of
 * the `Capability` enum (the type system already requires it, but this
 * function is the canonical builder).
 */
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
