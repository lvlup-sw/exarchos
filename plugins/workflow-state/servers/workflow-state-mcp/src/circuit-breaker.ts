import type { Event } from './types.js';
import { getFixCycleCount } from './events.js';

export interface CircuitBreakerState {
  readonly fixCycleCount: number;
  readonly maxFixCycles: number;
  readonly open: boolean;
  readonly lastTrippedAt?: string;
  readonly compoundStateId: string;
}

/**
 * Resolve the effective max fix cycles, preferring the MAX_FIX_CYCLES env var
 * when it parses to a valid positive integer.
 */
function resolveMaxFixCycles(defaultMax: number): number {
  const envVal = parseInt(process.env.MAX_FIX_CYCLES || '', 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : defaultMax;
}

/**
 * Check if the circuit breaker allows continued fix cycles for a compound state.
 * The fix cycle count is derived from the event log.
 */
export function checkCircuitBreaker(
  events: readonly Event[],
  compoundStateId: string,
  maxFixCycles: number,
): CircuitBreakerState {
  const effectiveMax = resolveMaxFixCycles(maxFixCycles);
  const fixCycleCount = getFixCycleCount(events, compoundStateId);
  const isOpen = fixCycleCount >= effectiveMax;

  return {
    fixCycleCount,
    maxFixCycles: effectiveMax,
    open: isOpen,
    compoundStateId,
    ...(isOpen && { lastTrippedAt: new Date().toISOString() }),
  };
}

/**
 * Get the current circuit breaker state for a compound state.
 * Equivalent to checkCircuitBreaker — provided as a read-only query alias.
 */
export function getCircuitBreakerState(
  events: readonly Event[],
  compoundStateId: string,
  maxFixCycles: number,
): CircuitBreakerState {
  return checkCircuitBreaker(events, compoundStateId, maxFixCycles);
}
