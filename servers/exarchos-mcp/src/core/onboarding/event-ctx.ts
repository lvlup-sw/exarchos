/**
 * The shared onboard event-seam builder (DR-7) — ONE home for the CAS-safe
 * `emit` + tail-scan that both the `onboard` handler and `doctor --fix` wire
 * over the real {@link EventStore}.
 *
 * Before this extraction the identical seam was duplicated in
 * `orchestrate/onboard/index.ts` (`buildEventCtx`) and
 * `orchestrate/doctor/index.ts` (`buildOnboardEventCtx`). It is the
 * safety-critical core of the feature (the CAS-pin idempotency trap is
 * sidestepped here by construction), so it lives in ONE place that both
 * facades import — drift between the two is now impossible (INV-2: behavior
 * lives in `core/onboarding/`, the facades only wire).
 */

import type { DispatchContext } from '../dispatch.js';
import { ONBOARD_STREAM_ID } from '../infra-streams.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { EmittedEvent, ReconcileEventCtx } from './reconcile.js';

/**
 * Build the {@link ReconcileEventCtx} over the real {@link DispatchContext.eventStore}.
 *
 * `emit` is a PLAIN append to {@link ONBOARD_STREAM_ID} — never CAS-pinned to a
 * prior append's returned sequence. The appender's idempotency cache-hit
 * precedes its CAS check, so a pinned retry would reproduce the same conflict
 * forever; plain appends sidestep that entirely.
 *
 * `readStreamTail` returns ONLY the tail of the CURRENT logical run — every
 * onboard event AFTER the stream's most recent `onboard.executed`. This is the
 * seam-owner's lever that reconciles two contracts the reconciler keys solely
 * on `repoRoot+trigger`:
 *
 *   - Crash recovery (INV-13): a dangling `onboard.requested` with NO paired
 *     `onboard.executed` sits AFTER the last completed run, so it is in the tail
 *     and the precheck resumes it (residual-only apply, no second `requested`).
 *   - Fresh-run reconciliation (DR-2 "re-run reconciles drift only"): a prior
 *     COMPLETED run's `requested`/`executed` pair is BEFORE the cut, so a fresh
 *     invocation sees an empty tail, does not idempotency-collapse, and
 *     reconciles whatever drift `diff` finds now.
 *
 * Without this cut the reconciler's `alreadyExecuted` short-circuit would make
 * every onboard after the first a permanent no-op on the same repo.
 */
export function buildOnboardEventCtx(ctx: DispatchContext): ReconcileEventCtx {
  return {
    emit: async (event: EmittedEvent): Promise<void> => {
      // Plain append: the EventStore allocates the sequence. We never pass an
      // expectedSequence, so a retry never reproduces a CAS conflict.
      await ctx.eventStore.append(ONBOARD_STREAM_ID, {
        type: event.type,
        data: event.data,
      });
    },
    readStreamTail: async (): Promise<readonly EmittedEvent[]> => {
      const events: WorkflowEvent[] = await ctx.eventStore.query(ONBOARD_STREAM_ID);
      const onboardEvents: EmittedEvent[] = [];
      for (const e of events) {
        if (e.type === 'onboard.requested' || e.type === 'onboard.executed') {
          // Validated on append; the stored `data` matches the emitted payload.
          onboardEvents.push({ type: e.type, data: e.data } as EmittedEvent);
        }
      }
      // Cut to the current logical run: everything after the last executed half.
      let lastExecutedIdx = -1;
      for (let i = onboardEvents.length - 1; i >= 0; i--) {
        if (onboardEvents[i].type === 'onboard.executed') {
          lastExecutedIdx = i;
          break;
        }
      }
      return onboardEvents.slice(lastExecutedIdx + 1);
    },
  };
}
