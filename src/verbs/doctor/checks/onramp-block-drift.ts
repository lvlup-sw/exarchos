/**
 * onramp-block-drift: the doctor roster adapter for {@link checkBlockDrift}.
 *
 * The AGENTS.md on-ramp block belongs to the consumer project, so the check
 * reads it from `process.cwd()`. In plugin mode the module lives in the plugin
 * cache. The check name maps to a `generate` step in the onboarding reconciler.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';
import { checkBlockDrift } from '../../onboard/block-drift.js';

export const onrampBlockDrift: CheckFn = async (): Promise<CheckResult> =>
  checkBlockDrift(process.cwd());
