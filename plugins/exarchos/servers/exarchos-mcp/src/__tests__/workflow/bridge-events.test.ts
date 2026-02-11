import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getRecentEventsFromStore, mapInternalToExternalType } from '../../workflow/events.js';
import { getRecentEvents } from '../../workflow/events.js';
import { EventStore } from '../../event-store/store.js';
import type { EventType as ExternalEventType } from '../../event-store/schemas.js';

describe('Bridge Events Fixes', () => {
  // ─── Fix 6: getRecentEventsFromStore guards non-positive count ───────────

  describe('getRecentEventsFromStore', () => {
    let tmpDir: string;
    let eventStore: EventStore;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-events-'));
      eventStore = new EventStore(tmpDir);
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when count is 0', async () => {
      // Seed some events so we can confirm they are NOT returned
      await eventStore.append('test-stream', {
        type: 'workflow.transition' as ExternalEventType,
        data: { from: 'ideate', to: 'plan', trigger: 'test', featureId: 'test-stream' },
      });

      const result = await getRecentEventsFromStore(eventStore, 'test-stream', 0);
      expect(result).toEqual([]);
    });

    it('should return empty array when count is negative', async () => {
      await eventStore.append('test-stream', {
        type: 'workflow.transition' as ExternalEventType,
        data: { from: 'ideate', to: 'plan', trigger: 'test', featureId: 'test-stream' },
      });

      const result = await getRecentEventsFromStore(eventStore, 'test-stream', -5);
      expect(result).toEqual([]);
    });

    it('should return recent events with { type, timestamp } shape for positive count', async () => {
      await eventStore.append('test-stream', {
        type: 'workflow.transition' as ExternalEventType,
        data: { from: 'ideate', to: 'plan', trigger: 'test', featureId: 'test-stream' },
      });

      const result = await getRecentEventsFromStore(eventStore, 'test-stream', 5);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('type');
      expect(result[0]).toHaveProperty('timestamp');
      // Should NOT have extra properties like sequence, data, etc.
      expect(Object.keys(result[0])).toEqual(['type', 'timestamp']);
    });
  });

  // ─── Fix 4: recentEvents shape consistency ──────────────────────────────

  describe('recentEvents shape consistency', () => {
    it('in-memory getRecentEvents returns full Event objects (before fix)', () => {
      // getRecentEvents returns Event[] which has type, timestamp, AND other fields
      const events = [
        {
          sequence: 1,
          version: '1.0' as const,
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'transition' as const,
          trigger: 'test',
          from: 'ideate',
          to: 'plan',
        },
      ];

      const recent = getRecentEvents(events, 5);
      // The in-memory version returns full Event objects
      expect(recent[0]).toHaveProperty('sequence');
      expect(recent[0]).toHaveProperty('type');
      expect(recent[0]).toHaveProperty('timestamp');
    });
  });

  // ─── Fix 1: Cancel event uses distinct type ─────────────────────────────

  describe('mapInternalToExternalType', () => {
    it('should map "cancel" to "workflow.cancel"', () => {
      const result = mapInternalToExternalType('cancel');
      expect(result).toBe('workflow.cancel');
    });

    it('should map "transition" to "workflow.transition"', () => {
      expect(mapInternalToExternalType('transition')).toBe('workflow.transition');
    });
  });
});
