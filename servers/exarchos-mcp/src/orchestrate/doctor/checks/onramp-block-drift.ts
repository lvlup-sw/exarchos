/**
 * onramp-block-drift — the roster adapter for the Task 013 on-ramp block drift
 * finding (DR-5).
 *
 * The behavior lives in `orchestrate/onboard/block-drift.ts`
 * ({@link checkBlockDrift}) — implemented + tested there but left UNREGISTERED in
 * the doctor roster, so DR-5's drift finding never fired in production. This thin
 * {@link CheckFn} adapter registers it: `checkBlockDrift` is a synchronous
 * `(projectRoot) => CheckResult`, so we resolve the consumer project root from
 * `process.cwd()` (the AGENTS.md on-ramp block is a consumer-project artifact,
 * mirroring the invariants-catalog / verification-toolchain checks' cwd anchor —
 * in plugin mode the module lives in the plugin cache) and hand it straight
 * through. No probe surface is needed; the drift check owns its own `fs` reads.
 *
 * The check's stable `name` is `onramp-block-drift` (BLOCK_DRIFT_CHECK_NAME),
 * which CHECK_CLASSIFICATION maps to the `generate` on-ramp-block-write step —
 * ordered BEFORE the retired-hooks removal step by the reconciler.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';
import { checkBlockDrift } from '../../onboard/block-drift.js';

export const onrampBlockDrift: CheckFn = async (): Promise<CheckResult> =>
  checkBlockDrift(process.cwd());
