// ─── Launcher on-ramps — per-harness declarative aggregate (DR-1, DR-3, DR-4) ─
//
// The five Tier-1 harness on-ramps, keyed by the launcher's schema-enum
// `HarnessTarget`. Each value is a `HarnessDescriptor` (pure data — no behavior,
// no function fields), so this map is a **data map**, never a harness-keyed
// *behavior* map: adding a harness is a new on-ramp module + one entry here, not
// a branch in the lifecycle core (INV-4 — one shared abstraction, no per-platform
// fan-out).
//
// This aggregate is what the harness-agnostic lifecycle core resolves a target
// through, and the surface the single-abstraction structural guard scans.
// ────────────────────────────────────────────────────────────────────────────

import type { HarnessTarget, HarnessDescriptor } from '../harness-registry.js';
import { claudeCodeOnRamp } from './claude-code.js';
import { codexOnRamp } from './codex.js';
import { cursorOnRamp } from './cursor.js';
import { copilotOnRamp } from './copilot.js';
import { opencodeOnRamp } from './opencode.js';

/**
 * Per-harness declarative launcher on-ramps, keyed by Tier-1 harness enum.
 * A `Readonly<Record<HarnessTarget, HarnessDescriptor>>` — pure data, one entry
 * per on-ramp module, exhaustive over the five Tier-1 harnesses.
 */
export const HARNESS_ON_RAMPS: Readonly<Record<HarnessTarget, HarnessDescriptor>> = {
  'claude-code': claudeCodeOnRamp,
  codex: codexOnRamp,
  cursor: cursorOnRamp,
  copilot: copilotOnRamp,
  opencode: opencodeOnRamp,
};

export {
  claudeCodeOnRamp,
  codexOnRamp,
  cursorOnRamp,
  copilotOnRamp,
  opencodeOnRamp,
};
