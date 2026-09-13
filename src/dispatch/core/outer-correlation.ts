// ─── The correlation packet a verb commits its operation record under ────────
//
// A verb that performs a bounded operation appends its record under the OUTER
// correlation packet — the one the work it describes already ran beneath. Off a
// real dispatch there is no ambient context to read, so one is minted.
//
// This lives here rather than inside a verb because more than one verb needs
// it and the two must not answer differently. The first copy of it sat in the
// executor, where committing outside the packet had left the operation record
// with no correlation id while every leaf event carried one — so the record and
// the work it described could not be joined. A second hand-written copy is how
// that comes back for whichever verb gets the copy slightly wrong.

import type { EventInput } from '../../events/atomic-appender.js';
import { snapshotCallerAuthorization } from '../caller-identity.js';
import { getDispatchContext, mintDispatchContext } from '../dispatch-context.js';
import type { DispatchContext as CorrelationContext } from '../dispatch-context.js';
import type { DispatchContext } from './dispatch.js';

/**
 * The ambient correlation packet, or a freshly minted one carrying the caller's
 * authorization snapshot when there is no dispatch in flight.
 */
export function outerCorrelation(ctx: DispatchContext): CorrelationContext {
  const active = getDispatchContext();
  if (active !== undefined) return active;
  const authorization =
    ctx.callerIdentity === undefined
      ? undefined
      : snapshotCallerAuthorization(ctx.callerIdentity, ctx.capabilityResolver);
  return mintDispatchContext(undefined, authorization);
}

/**
 * Fill an event's correlation triple from the ambient dispatch context.
 *
 * `decideOnce` is the substrate primitive, below the store method that stamps;
 * it persists what it is handed. Reading the ambient context here is what keeps
 * an operation record findable by the emission check running over the OUTER
 * dispatch, which queries by that dispatch's operation id.
 *
 * Each field is filled only when the caller left it unset, so a verb that has
 * already decided its own correlation keeps it.
 */
export function stampFromAmbient(event: EventInput): EventInput {
  const ctx = getDispatchContext();
  if (ctx === undefined) return event;
  return {
    ...event,
    ...(event.operationId === undefined ? { operationId: ctx.operationId } : {}),
    ...(event.correlationId === undefined ? { correlationId: ctx.correlationId } : {}),
    ...(event.causationId === undefined && ctx.causationId !== undefined
      ? { causationId: ctx.causationId }
      : {}),
  };
}
