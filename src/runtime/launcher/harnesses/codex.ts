/**
 * Launcher on-ramp for the Codex CLI harness. The value is pure data of type
 * `HarnessDescriptor`, so the pure-data type test also covers it. The data
 * comes from `HARNESS_DESCRIPTORS` in `harness-registry.ts`, and this module
 * holds no per-harness control flow.
 */

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the Codex CLI harness with. */
export const codexOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS.codex;
