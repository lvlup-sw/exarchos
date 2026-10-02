import type { Event } from './types.js';
import type { EventStore } from '../events/store.js';
import { getFixCycleCount, getFixCycleCountFromStore } from './events.js';

export interface CircuitBreakerState {
  readonly fixCycleCount: number;
  readonly maxFixCycles: number;
  readonly open: boolean;
  readonly lastTrippedAt?: string;
  readonly compoundStateId: string;
}

/** Returns `MAX_FIX_CYCLES` when it parses to a positive integer, and `defaultMax` otherwise. */
function resolveMaxFixCycles(defaultMax: number): number {
  const envVal = parseInt(process.env.MAX_FIX_CYCLES || '', 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : defaultMax;
}

/**
 * Reports whether the fix-cycle count for a compound state reached its limit.
 * The count and `lastTrippedAt` come only from the events, so a replay gives the same result.
 */
export function checkCircuitBreaker(
  events: readonly Event[],
  compoundStateId: string,
  maxFixCycles: number,
): CircuitBreakerState {
  const effectiveMax = resolveMaxFixCycles(maxFixCycles);
  const fixCycleCount = getFixCycleCount(events, compoundStateId);
  const isOpen = fixCycleCount >= effectiveMax;

  let lastTrippedAt: string | undefined;
  if (isOpen) {
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt === undefined) continue;
      if (
        evt.type === 'fix-cycle' &&
        evt.metadata?.compoundStateId === compoundStateId
      ) {
        lastTrippedAt = evt.timestamp;
        break;
      }
    }
  }

  return {
    fixCycleCount,
    maxFixCycles: effectiveMax,
    open: isOpen,
    compoundStateId,
    ...(lastTrippedAt !== undefined && { lastTrippedAt }),
  };
}

/** A read-only query alias of `checkCircuitBreaker`. */
export function getCircuitBreakerState(
  events: readonly Event[],
  compoundStateId: string,
  maxFixCycles: number,
): CircuitBreakerState {
  return checkCircuitBreaker(events, compoundStateId, maxFixCycles);
}

/** Runs the `checkCircuitBreaker` check on the count from the event store. The result has no `lastTrippedAt`. */
export async function checkCircuitBreakerFromStore(
  eventStore: EventStore,
  streamId: string,
  compoundStateId: string,
  maxFixCycles: number,
): Promise<CircuitBreakerState> {
  const effectiveMax = resolveMaxFixCycles(maxFixCycles);
  const fixCycleCount = await getFixCycleCountFromStore(eventStore, streamId, compoundStateId);
  const isOpen = fixCycleCount >= effectiveMax;

  return {
    fixCycleCount,
    maxFixCycles: effectiveMax,
    open: isOpen,
    compoundStateId,
  };
}
