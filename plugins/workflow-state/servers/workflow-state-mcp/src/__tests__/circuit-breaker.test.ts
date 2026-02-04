import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkCircuitBreaker,
  getCircuitBreakerState,
} from '../circuit-breaker.js';
import type { Event, EventType } from '../types.js';

// Helper to create a valid event
function makeEvent(overrides: Partial<Event> & { sequence: number; type: EventType; trigger: string }): Event {
  return {
    version: '1.0' as const,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('Circuit Breaker', () => {
  describe('checkCircuitBreaker', () => {
    it('CheckCircuitBreaker_UnderLimit_ReturnsClosed — Under limit, open=false', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'fix-attempt',
          metadata: { compoundStateId: 'delegate' },
        }),
      ];

      const state = checkCircuitBreaker(events, 'delegate', 3);
      expect(state.open).toBe(false);
      expect(state.fixCycleCount).toBe(1);
      expect(state.maxFixCycles).toBe(3);
      expect(state.compoundStateId).toBe('delegate');
    });

    it('CheckCircuitBreaker_AtLimit_ReturnsOpen — At limit, open=true', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'fix-1',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 3,
          type: 'fix-cycle',
          trigger: 'fix-2',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 4,
          type: 'fix-cycle',
          trigger: 'fix-3',
          metadata: { compoundStateId: 'delegate' },
        }),
      ];

      const state = checkCircuitBreaker(events, 'delegate', 3);
      expect(state.open).toBe(true);
      expect(state.fixCycleCount).toBe(3);
      expect(state.lastTrippedAt).toBeDefined();
    });

    it('CheckCircuitBreaker_DerivedFromEventLog_CorrectCount — Count matches event log', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'fix-1',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 3,
          type: 'transition',
          trigger: 'other-event',
        }),
        makeEvent({
          sequence: 4,
          type: 'fix-cycle',
          trigger: 'fix-2',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 5,
          type: 'fix-cycle',
          trigger: 'fix-for-other',
          metadata: { compoundStateId: 'review' },
        }),
      ];

      const state = checkCircuitBreaker(events, 'delegate', 5);
      expect(state.fixCycleCount).toBe(2);
      expect(state.open).toBe(false);
    });

    it('CheckCircuitBreaker_CompoundReEntry_ResetsCount — New compound-entry resets count', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'fix-1',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 3,
          type: 'fix-cycle',
          trigger: 'fix-2',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 4,
          type: 'compound-exit',
          trigger: 'exit-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        // Re-entry resets the count
        makeEvent({
          sequence: 5,
          type: 'compound-entry',
          trigger: 'reenter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 6,
          type: 'fix-cycle',
          trigger: 'fix-after-reset',
          metadata: { compoundStateId: 'delegate' },
        }),
      ];

      const state = checkCircuitBreaker(events, 'delegate', 3);
      expect(state.fixCycleCount).toBe(1);
      expect(state.open).toBe(false);
    });

    it('CheckCircuitBreaker_EnvOverride_UsesMaxFixCycles — MAX_FIX_CYCLES env respected', () => {
      const originalEnv = process.env.MAX_FIX_CYCLES;
      try {
        process.env.MAX_FIX_CYCLES = '2';

        const events: Event[] = [
          makeEvent({
            sequence: 1,
            type: 'compound-entry',
            trigger: 'enter-delegate',
            metadata: { compoundStateId: 'delegate' },
          }),
          makeEvent({
            sequence: 2,
            type: 'fix-cycle',
            trigger: 'fix-1',
            metadata: { compoundStateId: 'delegate' },
          }),
          makeEvent({
            sequence: 3,
            type: 'fix-cycle',
            trigger: 'fix-2',
            metadata: { compoundStateId: 'delegate' },
          }),
        ];

        // Pass maxFixCycles=5 but env says 2 — env should win
        const state = checkCircuitBreaker(events, 'delegate', 5);
        expect(state.open).toBe(true);
        expect(state.maxFixCycles).toBe(2);
        expect(state.fixCycleCount).toBe(2);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MAX_FIX_CYCLES;
        } else {
          process.env.MAX_FIX_CYCLES = originalEnv;
        }
      }
    });

    it('should ignore non-parseable MAX_FIX_CYCLES env and use provided value', () => {
      const originalEnv = process.env.MAX_FIX_CYCLES;
      try {
        process.env.MAX_FIX_CYCLES = 'not-a-number';

        const events: Event[] = [
          makeEvent({
            sequence: 1,
            type: 'compound-entry',
            trigger: 'enter-delegate',
            metadata: { compoundStateId: 'delegate' },
          }),
          makeEvent({
            sequence: 2,
            type: 'fix-cycle',
            trigger: 'fix-1',
            metadata: { compoundStateId: 'delegate' },
          }),
        ];

        const state = checkCircuitBreaker(events, 'delegate', 3);
        expect(state.open).toBe(false);
        expect(state.maxFixCycles).toBe(3);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MAX_FIX_CYCLES;
        } else {
          process.env.MAX_FIX_CYCLES = originalEnv;
        }
      }
    });

    it('should return open=false when no events exist', () => {
      const state = checkCircuitBreaker([], 'delegate', 3);
      expect(state.open).toBe(false);
      expect(state.fixCycleCount).toBe(0);
    });
  });

  describe('getCircuitBreakerState', () => {
    it('should return the same state as checkCircuitBreaker', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'fix-1',
          metadata: { compoundStateId: 'delegate' },
        }),
      ];

      const checkResult = checkCircuitBreaker(events, 'delegate', 3);
      const getResult = getCircuitBreakerState(events, 'delegate', 3);

      expect(getResult.fixCycleCount).toBe(checkResult.fixCycleCount);
      expect(getResult.open).toBe(checkResult.open);
      expect(getResult.maxFixCycles).toBe(checkResult.maxFixCycles);
      expect(getResult.compoundStateId).toBe(checkResult.compoundStateId);
    });

    it('should include lastTrippedAt when circuit is open', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'fix-1',
          metadata: { compoundStateId: 'delegate' },
          timestamp: '2025-01-15T10:01:00.000Z',
        }),
        makeEvent({
          sequence: 3,
          type: 'fix-cycle',
          trigger: 'fix-2',
          metadata: { compoundStateId: 'delegate' },
          timestamp: '2025-01-15T10:02:00.000Z',
        }),
      ];

      const state = getCircuitBreakerState(events, 'delegate', 2);
      expect(state.open).toBe(true);
      expect(state.lastTrippedAt).toBeDefined();
    });
  });
});
