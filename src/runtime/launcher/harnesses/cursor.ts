/**
 * Launcher on-ramp for the Cursor CLI harness.
 * The value comes from `HARNESS_DESCRIPTORS`, which holds the descriptor data.
 * The `HarnessDescriptor` type is pure data, so this module holds no per-harness control flow.
 * The launch binary is `cursor-agent`. The `cursor` GUI shim is only a detection fallback.
 */

import { HARNESS_DESCRIPTORS, type HarnessDescriptor } from '../harness-registry.js';

/** Declarative spawn descriptor the launcher on-ramps the Cursor CLI harness with. */
export const cursorOnRamp: HarnessDescriptor = HARNESS_DESCRIPTORS.cursor;
