// ─── Launcher on-ramp — Claude Code harness (DR-1, DR-4) ─────────────────────
//
// A *thin, declarative* per-harness on-ramp. The exported value is typed as
// `HarnessDescriptor`, so it inherits the compile-time pure-data pin asserted in
// `harness-registry.type-test.ts` (`HasFunctionDeep<HarnessDescriptor>` — a
// green `tsc`): a function-valued field, or any behavior hook, cannot hide in an
// on-ramp. There is **no per-harness control-flow** here — an on-ramp is data,
// never behavior.
//
// The descriptor data has a single source of truth in `HARNESS_DESCRIPTORS`
// (`harness-registry.ts`); this module is the per-harness *on-ramp surface* the
// lifecycle core spawns through and that the single-abstraction structural guard
// scans. Adding a Tier-1 harness is a new on-ramp module + a registry entry, not
// a branch in the lifecycle core (INV-4).
// ────────────────────────────────────────────────────────────────────────────

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the Claude Code harness with. */
export const claudeCodeOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS['claude-code'];
