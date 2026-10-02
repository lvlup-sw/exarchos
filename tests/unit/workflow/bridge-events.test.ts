import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getRecentEventsFromStore, mapInternalToExternalType } from '../../../src/workflow/events.js';
import { getRecentEvents } from '../../../src/workflow/events.js';
import { EventStore } from '../../../src/events/store.js';
import type { EventType as ExternalEventType } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('Bridge Events Fixes', () => {
  describe('getRecentEventsFromStore', () => {
    let tmpDir: string;
    let eventStore: EventStore;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-events-'));
      eventStore = new EventStore(tmpDir);
    });

    afterEach(async () => {
      await rmrfAsync(tmpDir);
    });

    /** The stream holds one event, so the empty result comes from the count guard. */
    it('should return empty array when count is 0', async () => {
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
      expect(Object.keys(result[0])).toEqual(['type', 'timestamp']);
    });
  });

  describe('recentEvents shape consistency', () => {
    it('in-memory getRecentEvents returns full Event objects (before fix)', () => {
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
      expect(recent[0]).toHaveProperty('sequence');
      expect(recent[0]).toHaveProperty('type');
      expect(recent[0]).toHaveProperty('timestamp');
    });
  });

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
