/**
 * The launcher on-ramp for the Claude Code harness.
 * An on-ramp is data, not behavior, so this module holds no per-harness control flow.
 * The value has type `HarnessDescriptor`, so the pure-data type test also covers it.
 * The descriptor data comes from `HARNESS_DESCRIPTORS` in `harness-registry.ts`.
 * A new Tier-1 harness needs a new on-ramp module and a registry entry, not a branch in the lifecycle core.
 */

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the Claude Code harness with. */
export const claudeCodeOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS['claude-code'];
