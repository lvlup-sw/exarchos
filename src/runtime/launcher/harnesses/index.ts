/**
 * The launcher on-ramps of the five Tier-1 harnesses. Each on-ramp is a
 * pure-data `HarnessDescriptor`. Thus a new harness needs a new on-ramp module
 * and one entry here, not a branch in the lifecycle core.
 */

import type { HarnessTarget, HarnessDescriptor } from '../harness-registry.js';
import { claudeCodeOnRamp } from './claude-code.js';
import { codexOnRamp } from './codex.js';
import { cursorOnRamp } from './cursor.js';
import { copilotOnRamp } from './copilot.js';
import { opencodeOnRamp } from './opencode.js';

/** The on-ramp of each Tier-1 harness, keyed by `HarnessTarget`. */
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
