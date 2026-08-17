// ─── Launcher on-ramp — Cursor CLI harness (DR-1, DR-4) ──────────────────────
//
// A *thin, declarative* per-harness on-ramp. The exported value is typed as
// `HarnessDescriptor`, so it inherits the compile-time pure-data pin asserted in
// `harness-registry.type-test.ts`: no function-valued field or behavior hook can
// hide in an on-ramp, and there is **no per-harness control-flow** here.
//
// The descriptor data has a single source of truth in `HARNESS_DESCRIPTORS`
// (`harness-registry.ts`); Cursor's primary launch binary is `cursor-agent`
// (the `cursor` GUI shim is a detection fallback, not the launch target). This
// module is the per-harness on-ramp surface the lifecycle core spawns through
// (INV-4 — no harness branching in logic).
// ────────────────────────────────────────────────────────────────────────────

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the Cursor CLI harness with. */
export const cursorOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS.cursor;
