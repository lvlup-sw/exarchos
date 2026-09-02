// ─── Launcher on-ramp — GitHub Copilot CLI harness (DR-1, DR-4) ──────────────
//
// A *thin, declarative* per-harness on-ramp. The exported value is typed as
// `HarnessDescriptor`, so it inherits the compile-time pure-data pin asserted in
// `harness-registry.type-test.ts`: no function-valued field or behavior hook can
// hide in an on-ramp, and there is **no per-harness control-flow** here.
//
// The descriptor data has a single source of truth in `HARNESS_DESCRIPTORS`
// (`harness-registry.ts`); this module is the per-harness on-ramp surface the
// lifecycle core spawns through (INV-4 — no harness branching in logic).
// ────────────────────────────────────────────────────────────────────────────

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the Copilot CLI harness with. */
export const copilotOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS.copilot;
