/**
 * Launcher on-ramp for the OpenCode CLI harness.
 *
 * The export has the `HarnessDescriptor` type, so the pure-data check in `harness-registry.type-test.ts`
 * covers it. No function-valued field or behavior hook can hide here. The data comes from
 * `HARNESS_DESCRIPTORS` in `harness-registry.ts`, and this module adds no harness-specific logic.
 */

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the OpenCode CLI harness with. */
export const opencodeOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS.opencode;
