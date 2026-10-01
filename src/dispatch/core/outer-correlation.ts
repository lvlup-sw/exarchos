/**
 * The correlation packet that a verb commits its operation record under. The record goes under the
 * outer packet, which the described work already ran beneath. Off a real dispatch there is no
 * ambient context, so the function mints one.
 *
 * More than one verb needs this, and they must give the same answer. A record committed outside the
 * packet gets no correlation id, so it does not join to its leaf events.
 */

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
 * Fill an event's correlation triple from the ambient dispatch context. The callers commit through
 * `decideOnce`, which persists what it gets and does not stamp. This stamp lets the emission check
 * of the outer dispatch find the record by its operation id. The function fills only the fields
 * that the caller left unset.
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
