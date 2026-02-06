import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendEvent,
  getFixCycleCount,
  getRecentEvents,
  getPhaseDuration,
  EVENT_LOG_MAX,
} from '../events.js';
import type { Event, EventType } from '../types.js';
import { EventSchema } from '../schemas.js';

// Helper to create a valid event
function makeEvent(overrides: Partial<Event> & { sequence: number; type: EventType; trigger: string }): Event {
  return {
    version: '1.0' as const,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('Event Log', () => {
  describe('appendEvent', () => {
    it('AppendEvent_NewEvent_IncrementsSequence — Sequence goes from 0 to 1 to 2', () => {
      // First append: sequence 0 -> 1
      const result1 = appendEvent([], 0, 'transition', 'start', {
        from: 'ideate',
        to: 'plan',
      });
      expect(result1.eventSequence).toBe(1);
      expect(result1.event.sequence).toBe(1);
      expect(result1.events).toHaveLength(1);

      // Second append: sequence 1 -> 2
      const result2 = appendEvent(result1.events, result1.eventSequence, 'transition', 'continue', {
        from: 'plan',
        to: 'delegate',
      });
      expect(result2.eventSequence).toBe(2);
      expect(result2.event.sequence).toBe(2);
      expect(result2.events).toHaveLength(2);
    });

    it('AppendEvent_CapExceeded_DiscardsFIFO — At 100, oldest removed', () => {
      // Build up 100 events
      let events: Event[] = [];
      let seq = 0;
      for (let i = 0; i < 100; i++) {
        const result = appendEvent(events, seq, 'transition', `trigger-${i}`);
        events = result.events;
        seq = result.eventSequence;
      }
      expect(events).toHaveLength(100);
      expect(seq).toBe(100);

      // Adding one more should discard the oldest
      const result = appendEvent(events, seq, 'transition', 'trigger-overflow');
      expect(result.events).toHaveLength(100);
      expect(result.eventSequence).toBe(101);
      // The oldest event (sequence 1) should be gone
      expect(result.events[0].sequence).toBe(2);
      // The newest event should be at the end
      expect(result.events[result.events.length - 1].sequence).toBe(101);
    });

    it('AppendEvent_AllEventTypes_CorrectSchema — Each event type produces valid event', () => {
      const eventTypes: EventType[] = [
        'transition',
        'checkpoint',
        'guard-failed',
        'compound-entry',
        'compound-exit',
        'fix-cycle',
        'circuit-open',
        'compensation',
        'cancel',
        'field-update',
      ];

      for (const type of eventTypes) {
        const result = appendEvent([], 0, type, `trigger-${type}`, {
          from: 'phase-a',
          to: 'phase-b',
          metadata: { key: 'value' },
        });
        const parseResult = EventSchema.safeParse(result.event);
        expect(parseResult.success, `Event type '${type}' should produce valid schema`).toBe(true);
      }
    });

    it('AppendEvent_VersionField_PresentOnAllEvents — Version is always "1.0"', () => {
      let events: Event[] = [];
      let seq = 0;
      for (let i = 0; i < 5; i++) {
        const result = appendEvent(events, seq, 'transition', `trigger-${i}`);
        events = result.events;
        seq = result.eventSequence;
      }

      for (const event of events) {
        expect(event.version).toBe('1.0');
      }
    });

    it('should include optional from, to, and metadata when provided', () => {
      const result = appendEvent([], 0, 'transition', 'test-trigger', {
        from: 'ideate',
        to: 'plan',
        metadata: { reason: 'approved' },
      });

      expect(result.event.from).toBe('ideate');
      expect(result.event.to).toBe('plan');
      expect(result.event.metadata).toEqual({ reason: 'approved' });
    });

    it('should omit from, to, and metadata when not provided', () => {
      const result = appendEvent([], 0, 'checkpoint', 'manual');

      expect(result.event.from).toBeUndefined();
      expect(result.event.to).toBeUndefined();
      expect(result.event.metadata).toBeUndefined();
    });

    it('should not mutate the input events array', () => {
      const original: Event[] = [];
      const result = appendEvent(original, 0, 'transition', 'test');
      expect(original).toHaveLength(0);
      expect(result.events).toHaveLength(1);
    });
  });

  describe('getFixCycleCount', () => {
    it('should count fix-cycle events using compoundStateId metadata key (Bug 6 regression)', () => {
      // This test uses events matching what executeTransition actually writes:
      // compound-entry and fix-cycle events with metadata.compoundStateId
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'execute-transition',
          metadata: { compoundStateId: 'implementation' },
        }),
        makeEvent({
          sequence: 2,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          metadata: { compoundStateId: 'implementation' },
        }),
        makeEvent({
          sequence: 3,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          metadata: { compoundStateId: 'implementation' },
        }),
      ];

      expect(getFixCycleCount(events, 'implementation')).toBe(2);
    });

    it('GetFixCycleCount_FromEventLog_CorrectCount — Counts fix-cycle events for specific compound', () => {
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
        makeEvent({
          sequence: 3,
          type: 'fix-cycle',
          trigger: 'fix-attempt',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 4,
          type: 'fix-cycle',
          trigger: 'fix-attempt',
          metadata: { compoundStateId: 'other-compound' },
        }),
      ];

      expect(getFixCycleCount(events, 'delegate')).toBe(2);
    });

    it('should return 0 when no fix-cycle events exist', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'compound-entry',
          trigger: 'enter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 2,
          type: 'transition',
          trigger: 'normal',
        }),
      ];

      expect(getFixCycleCount(events, 'delegate')).toBe(0);
    });

    it('should only count fix-cycle events after the most recent compound-entry', () => {
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
          trigger: 'old-fix',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 3,
          type: 'compound-exit',
          trigger: 'exit-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        // Re-enter the compound — this resets the count
        makeEvent({
          sequence: 4,
          type: 'compound-entry',
          trigger: 'reenter-delegate',
          metadata: { compoundStateId: 'delegate' },
        }),
        makeEvent({
          sequence: 5,
          type: 'fix-cycle',
          trigger: 'new-fix',
          metadata: { compoundStateId: 'delegate' },
        }),
      ];

      expect(getFixCycleCount(events, 'delegate')).toBe(1);
    });

    it('should return 0 when no compound-entry exists for the compound', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'fix-cycle',
          trigger: 'fix-attempt',
          metadata: { compoundStateId: 'delegate' },
        }),
      ];

      expect(getFixCycleCount(events, 'delegate')).toBe(0);
    });
  });

  describe('getRecentEvents', () => {
    it('GetRecentEvents_LastN_ReturnsCorrectSlice — Returns last N events', () => {
      const events: Event[] = [];
      for (let i = 1; i <= 10; i++) {
        events.push(
          makeEvent({
            sequence: i,
            type: 'transition',
            trigger: `trigger-${i}`,
          }),
        );
      }

      const recent = getRecentEvents(events, 3);
      expect(recent).toHaveLength(3);
      expect(recent[0].sequence).toBe(8);
      expect(recent[1].sequence).toBe(9);
      expect(recent[2].sequence).toBe(10);
    });

    it('should return all events when count exceeds length', () => {
      const events: Event[] = [
        makeEvent({ sequence: 1, type: 'transition', trigger: 'a' }),
        makeEvent({ sequence: 2, type: 'transition', trigger: 'b' }),
      ];

      const recent = getRecentEvents(events, 10);
      expect(recent).toHaveLength(2);
    });

    it('should return empty array when events is empty', () => {
      expect(getRecentEvents([], 5)).toEqual([]);
    });

    it('should return empty array when count is 0', () => {
      const events: Event[] = [
        makeEvent({ sequence: 1, type: 'transition', trigger: 'a' }),
      ];
      expect(getRecentEvents(events, 0)).toEqual([]);
    });
  });

  describe('getPhaseDuration', () => {
    it('should return duration in milliseconds between phase entry and exit', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'transition',
          trigger: 'start',
          to: 'plan',
          timestamp: '2025-01-15T10:00:00.000Z',
        }),
        makeEvent({
          sequence: 2,
          type: 'transition',
          trigger: 'finish',
          from: 'plan',
          to: 'delegate',
          timestamp: '2025-01-15T10:05:00.000Z',
        }),
      ];

      const duration = getPhaseDuration(events, 'plan');
      expect(duration).toBe(5 * 60 * 1000); // 5 minutes in ms
    });

    it('should return null when phase has no entry transition', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'transition',
          trigger: 'start',
          to: 'delegate',
          timestamp: '2025-01-15T10:00:00.000Z',
        }),
      ];

      expect(getPhaseDuration(events, 'plan')).toBeNull();
    });

    it('should return null when phase has no exit transition', () => {
      const events: Event[] = [
        makeEvent({
          sequence: 1,
          type: 'transition',
          trigger: 'start',
          to: 'plan',
          timestamp: '2025-01-15T10:00:00.000Z',
        }),
      ];

      expect(getPhaseDuration(events, 'plan')).toBeNull();
    });

    it('should return null for empty events', () => {
      expect(getPhaseDuration([], 'plan')).toBeNull();
    });

    it('should use the most recent entry and exit for a phase', () => {
      const events: Event[] = [
        // First entry into plan
        makeEvent({
          sequence: 1,
          type: 'transition',
          trigger: 'start',
          to: 'plan',
          timestamp: '2025-01-15T10:00:00.000Z',
        }),
        // Exit plan
        makeEvent({
          sequence: 2,
          type: 'transition',
          trigger: 'continue',
          from: 'plan',
          to: 'delegate',
          timestamp: '2025-01-15T10:02:00.000Z',
        }),
        // Re-entry into plan
        makeEvent({
          sequence: 3,
          type: 'transition',
          trigger: 'back',
          to: 'plan',
          timestamp: '2025-01-15T11:00:00.000Z',
        }),
        // Exit plan again
        makeEvent({
          sequence: 4,
          type: 'transition',
          trigger: 'continue',
          from: 'plan',
          to: 'delegate',
          timestamp: '2025-01-15T11:10:00.000Z',
        }),
      ];

      // Should use the most recent entry/exit pair
      const duration = getPhaseDuration(events, 'plan');
      expect(duration).toBe(10 * 60 * 1000); // 10 minutes
    });
  });

  describe('EVENT_LOG_MAX', () => {
    it('should default to 100', () => {
      expect(EVENT_LOG_MAX).toBe(100);
    });
  });
});
