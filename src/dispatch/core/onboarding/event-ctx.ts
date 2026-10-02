/**
 * The shared onboard event seam. The `onboard` handler and `doctor --fix` both wire the CAS-safe
 * `emit` and the tail scan from here over the real {@link EventStore}. The behavior lives here,
 * and the two facades only wire it.
 */

import type { DispatchContext } from '../dispatch.js';
import { ONBOARD_STREAM_ID } from '../infra-streams.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import type { EmittedEvent, ReconcileEventCtx } from './reconcile.js';

/**
 * Builds the {@link ReconcileEventCtx} over the real {@link DispatchContext.eventStore}.
 *
 * `emit` is a plain append to {@link ONBOARD_STREAM_ID} with no expected sequence. The appender
 * checks its idempotency cache before CAS, so a pinned retry repeats the same conflict forever.
 *
 * `readStreamTail` returns only the onboard events after the last `onboard.executed`. Thus a
 * dangling `onboard.requested` from a crash stays in the tail, and the precheck resumes it. A
 * completed run falls before the cut, so a fresh run reconciles the current drift. Without the cut,
 * `alreadyExecuted` makes each onboard after the first a no-op. The store validates `data` on
 * append, so the cast to `EmittedEvent` is safe.
 */
export function buildOnboardEventCtx(ctx: DispatchContext): ReconcileEventCtx {
  return {
    emit: async (event: EmittedEvent): Promise<void> => {
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
          onboardEvents.push({ type: e.type, data: e.data } as EmittedEvent);
        }
      }
      let lastExecutedIdx = -1;
      for (let i = onboardEvents.length - 1; i >= 0; i--) {
        if (onboardEvents[i]?.type === 'onboard.executed') {
          lastExecutedIdx = i;
          break;
        }
      }
      return onboardEvents.slice(lastExecutedIdx + 1);
    },
  };
}
