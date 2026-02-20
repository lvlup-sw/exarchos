import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCleanup, configureCleanupEventStore } from '../../workflow/cleanup.js';
import { handleInit, configureWorkflowEventStore } from '../../workflow/tools.js';
import { handleWorkflow } from '../../workflow/composite.js';
import { EventStore } from '../../event-store/store.js';
import type { EventStore as EventStoreType } from '../../event-store/store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cleanup-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return JSON.parse(await fs.readFile(stateFile, 'utf-8'));
}

async function writeRawState(featureId: string, state: Record<string, unknown>): Promise<void> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

describe('handleCleanup', () => {
  describe('rejection paths', () => {
    it('should return STATE_NOT_FOUND for non-existent feature', async () => {
      const result = await handleCleanup({ featureId: 'nonexistent', mergeVerified: true }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });

    it('should return ALREADY_COMPLETED for completed workflow', async () => {
      await handleInit({ featureId: 'already-done', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('already-done');
      raw.phase = 'completed';
      await writeRawState('already-done', raw);

      const result = await handleCleanup({ featureId: 'already-done', mergeVerified: true }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ALREADY_COMPLETED');
    });

    it('should return INVALID_TRANSITION for cancelled workflow', async () => {
      await handleInit({ featureId: 'cancelled-wf', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cancelled-wf');
      raw.phase = 'cancelled';
      await writeRawState('cancelled-wf', raw);

      const result = await handleCleanup({ featureId: 'cancelled-wf', mergeVerified: true }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TRANSITION');
    });

    it('should return GUARD_FAILED when mergeVerified is false', async () => {
      await handleInit({ featureId: 'not-merged', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('not-merged');
      raw.phase = 'review';
      await writeRawState('not-merged', raw);

      const result = await handleCleanup({ featureId: 'not-merged', mergeVerified: false }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');
    });
  });

  describe('happy path', () => {
    it('should transition to completed from review phase', async () => {
      await handleInit({ featureId: 'cleanup-review', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-review');
      raw.phase = 'review';
      await writeRawState('cleanup-review', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-review',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
        mergedBranches: ['feature/task-1'],
      }, tmpDir);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
    });

    it('should backfill synthesis metadata from input', async () => {
      await handleInit({ featureId: 'cleanup-synth', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-synth');
      raw.phase = 'review';
      await writeRawState('cleanup-synth', raw);

      await handleCleanup({
        featureId: 'cleanup-synth',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
        mergedBranches: ['feature/task-1', 'feature/task-2'],
      }, tmpDir);

      const state = await readRawState('cleanup-synth');
      const synthesis = state.synthesis as Record<string, unknown>;
      expect(synthesis.prUrl).toBe('https://github.com/test/pr/1');
      expect(synthesis.mergedBranches).toEqual(['feature/task-1', 'feature/task-2']);
    });

    it('should force-resolve blocking review statuses', async () => {
      await handleInit({ featureId: 'cleanup-reviews', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-reviews');
      raw.phase = 'review';
      raw.reviews = {
        'task-1': { status: 'in-progress' },
        'task-2': { specReview: { status: 'fail' }, qualityReview: { status: 'needs_fixes' } },
      };
      await writeRawState('cleanup-reviews', raw);

      await handleCleanup({
        featureId: 'cleanup-reviews',
        mergeVerified: true,
      }, tmpDir);

      const state = await readRawState('cleanup-reviews');
      const reviews = state.reviews as Record<string, Record<string, unknown>>;
      expect(reviews['task-1'].status).toBe('approved');
      expect((reviews['task-2'].specReview as Record<string, unknown>).status).toBe('approved');
      expect((reviews['task-2'].qualityReview as Record<string, unknown>).status).toBe('approved');
    });

    it('should return dryRun preview without modifying state', async () => {
      await handleInit({ featureId: 'cleanup-dry', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-dry');
      raw.phase = 'review';
      await writeRawState('cleanup-dry', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-dry',
        mergeVerified: true,
        dryRun: true,
      }, tmpDir);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.dryRun).toBe(true);

      // State should NOT be modified
      const state = await readRawState('cleanup-dry');
      expect(state.phase).toBe('review');
    });

    it('should work from delegate phase (feature workflow)', async () => {
      await handleInit({ featureId: 'cleanup-delegate', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-delegate');
      raw.phase = 'delegate';
      await writeRawState('cleanup-delegate', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-delegate',
        mergeVerified: true,
      }, tmpDir);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
      expect((result.data as Record<string, unknown>)?.previousPhase).toBe('delegate');
    });

    it('should work for debug workflow', async () => {
      await handleInit({ featureId: 'cleanup-debug', workflowType: 'debug' }, tmpDir);
      const raw = await readRawState('cleanup-debug');
      raw.phase = 'investigate';
      await writeRawState('cleanup-debug', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-debug',
        mergeVerified: true,
      }, tmpDir);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
    });

    it('should work for refactor workflow', async () => {
      await handleInit({ featureId: 'cleanup-refactor', workflowType: 'refactor' }, tmpDir);
      const raw = await readRawState('cleanup-refactor');
      raw.phase = 'overhaul-review';
      await writeRawState('cleanup-refactor', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-refactor',
        mergeVerified: true,
      }, tmpDir);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
    });
  });

  describe('event store emission', () => {
    it('should emit workflow.cleanup event when event store is configured', async () => {
      const mockEventStore = {
        append: vi.fn().mockResolvedValue({
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: 'workflow.cleanup',
          streamId: 'cleanup-event-test',
          schemaVersion: '1.0',
        }),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStoreType;

      configureCleanupEventStore(mockEventStore);

      await handleInit({ featureId: 'cleanup-event-test', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-event-test');
      raw.phase = 'review';
      await writeRawState('cleanup-event-test', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-event-test',
        mergeVerified: true,
      }, tmpDir);

      expect(result.success).toBe(true);
      // v2 event-first: append is called with idempotency key (3rd arg)
      expect(mockEventStore.append).toHaveBeenCalledWith(
        'cleanup-event-test',
        expect.objectContaining({
          type: 'workflow.cleanup',
          data: expect.objectContaining({
            featureId: 'cleanup-event-test',
          }),
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringContaining('cleanup-event-test:cleanup:'),
        }),
      );

      configureCleanupEventStore(null);
    });

    it('should abort cleanup when event store append fails (v2 event-first)', async () => {
      const mockEventStore = {
        append: vi.fn().mockRejectedValue(new Error('store error')),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStoreType;

      configureCleanupEventStore(mockEventStore);

      await handleInit({ featureId: 'cleanup-store-fail', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-store-fail');
      raw.phase = 'review';
      await writeRawState('cleanup-store-fail', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-store-fail',
        mergeVerified: true,
      }, tmpDir);

      // v2 event-first: event failure aborts cleanup
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('store error');

      // State should NOT have been written
      const state = await readRawState('cleanup-store-fail');
      expect(state.phase).toBe('review');

      configureCleanupEventStore(null);
    });
  });

  describe('composite routing', () => {
    it('should route cleanup action to handleCleanup', async () => {
      await handleInit({ featureId: 'composite-test', workflowType: 'feature' }, tmpDir);

      const result = await handleWorkflow({
        action: 'cleanup',
        featureId: 'composite-test',
        mergeVerified: false,
      }, tmpDir);

      // Should fail with GUARD_FAILED (not UNKNOWN_ACTION)
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');
    });
  });

  describe('ES v2 event-first cleanup', () => {
    let eventStore: EventStore;

    beforeEach(() => {
      eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureCleanupEventStore(eventStore);
    });

    afterEach(() => {
      configureWorkflowEventStore(null);
      configureCleanupEventStore(null);
    });

    it('HandleCleanup_EsVersion2_EmitsEventsBeforeStateWrite', async () => {
      // Arrange — init creates v2 workflow with event store configured
      await handleInit({ featureId: 'v2-event-order', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('v2-event-order');
      raw.phase = 'synthesize';
      await writeRawState('v2-event-order', raw);

      // Act
      const result = await handleCleanup({
        featureId: 'v2-event-order',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/42',
        mergedBranches: ['feature/task-1'],
      }, tmpDir);

      // Assert — cleanup succeeded
      expect(result.success).toBe(true);

      // Query event stream for cleanup-related events
      // Note: HSM emits 'cleanup' type events which map to 'workflow.cleanup'
      // So we look for workflow.cleanup (transition + explicit cleanup event)
      const allEvents = await eventStore.query('v2-event-order');
      const cleanupEvents = allEvents.filter(e => e.type === 'workflow.cleanup');
      const patchEvents = allEvents.filter(e => e.type === 'state.patched');

      // Verify cleanup events exist (HSM transition event + explicit cleanup event = 2)
      expect(cleanupEvents.length).toBeGreaterThanOrEqual(2);
      expect(patchEvents.length).toBeGreaterThanOrEqual(1);

      // Verify state was written (event-first means events are committed,
      // then state is written as follow-up materialization)
      const state = await readRawState('v2-event-order');
      expect(state.phase).toBe('completed');

      // Verify event timestamps are within a reasonable window of updatedAt
      // (events are emitted just before state write, timestamps may differ by a few ms)
      const updatedAt = new Date(state.updatedAt as string).getTime();
      for (const evt of [...cleanupEvents, ...patchEvents]) {
        const eventTime = new Date(evt.timestamp).getTime();
        // Events should be within 1000ms of the state write timestamp (generous for CI)
        expect(Math.abs(eventTime - updatedAt)).toBeLessThan(1000);
      }
    });

    it('HandleCleanup_EsVersion2_IdempotencyKeysPresent', async () => {
      // Arrange
      await handleInit({ featureId: 'v2-idemp', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('v2-idemp');
      raw.phase = 'synthesize';
      await writeRawState('v2-idemp', raw);

      // Act — call cleanup
      await handleCleanup({
        featureId: 'v2-idemp',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir);

      // Query all events
      const allEvents = await eventStore.query('v2-idemp');
      const cleanupRelated = allEvents.filter(e =>
        e.type === 'state.patched' ||
        e.type === 'workflow.transition' ||
        e.type === 'workflow.cleanup'
      );

      // Assert — all cleanup-related events have idempotency keys
      expect(cleanupRelated.length).toBeGreaterThanOrEqual(2); // at least transition + cleanup
      for (const evt of cleanupRelated) {
        expect(evt.idempotencyKey).toBeDefined();
        expect(evt.idempotencyKey).toContain('v2-idemp:cleanup:');
      }

      // Act — call cleanup again (should be idempotent via ALREADY_COMPLETED guard)
      // But we can verify no duplicate events were added by checking count
      const eventCountBefore = allEvents.length;
      const secondResult = await handleCleanup({
        featureId: 'v2-idemp',
        mergeVerified: true,
      }, tmpDir);
      // Second call should fail with ALREADY_COMPLETED
      expect(secondResult.success).toBe(false);
      expect(secondResult.error?.code).toBe('ALREADY_COMPLETED');

      const eventsAfter = await eventStore.query('v2-idemp');
      expect(eventsAfter.length).toBe(eventCountBefore);
    });

    it('HandleCleanup_EsVersion2_EventFailure_AbortsStateWrite', async () => {
      // Arrange — init with real event store for v2 workflow creation
      await handleInit({ featureId: 'v2-evt-fail', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('v2-evt-fail');
      raw.phase = 'synthesize';
      await writeRawState('v2-evt-fail', raw);

      // Mock event store append to fail AFTER init
      const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
        new Error('Disk full'),
      );

      // Act
      const result = await handleCleanup({
        featureId: 'v2-evt-fail',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir);

      // Assert — should return error
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('Disk full');

      // Assert — state file should be unchanged (still synthesize)
      const state = await readRawState('v2-evt-fail');
      expect(state.phase).toBe('synthesize');

      appendSpy.mockRestore();
    });

    it('HandleCleanup_EsVersion2_EmitsStatePatchedForBackfill', async () => {
      // Arrange — v2 workflow with reviews to force-resolve
      await handleInit({ featureId: 'v2-patch', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('v2-patch');
      raw.phase = 'review';
      raw.reviews = {
        'task-1': { status: 'in-progress' },
      };
      await writeRawState('v2-patch', raw);

      // Act
      const result = await handleCleanup({
        featureId: 'v2-patch',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/99',
        mergedBranches: ['feature/branch-a', 'feature/branch-b'],
      }, tmpDir);

      expect(result.success).toBe(true);

      // Query for state.patched events
      const allEvents = await eventStore.query('v2-patch');
      const patchEvents = allEvents.filter(e => e.type === 'state.patched');

      // Assert — should have a state.patched event with synthesis/review data
      expect(patchEvents.length).toBeGreaterThanOrEqual(1);
      const patchData = patchEvents[0].data as Record<string, unknown>;
      expect(patchData.featureId).toBe('v2-patch');
      expect(patchData.fields).toBeDefined();
      const fields = patchData.fields as string[];
      // Should include synthesis and/or reviews data
      expect(
        fields.includes('synthesis') || fields.includes('reviews') || fields.includes('artifacts'),
      ).toBe(true);
      // The patch should contain the actual backfilled data
      const patch = patchData.patch as Record<string, unknown>;
      expect(patch).toBeDefined();
      if (patch.synthesis) {
        const synthPatch = patch.synthesis as Record<string, unknown>;
        expect(synthPatch.prUrl).toBe('https://github.com/test/pr/99');
        expect(synthPatch.mergedBranches).toEqual(['feature/branch-a', 'feature/branch-b']);
      }
      if (patch.reviews) {
        const reviewsPatch = patch.reviews as Record<string, Record<string, unknown>>;
        expect(reviewsPatch['task-1'].status).toBe('approved');
      }
    });

    it('HandleCleanup_V1Legacy_StillWorksWithBestEffortEvents', async () => {
      // Arrange — create a v1 workflow (no _esVersion field)
      // Disconnect event store from init so workflow is created without _esVersion: 2
      configureWorkflowEventStore(null);
      await handleInit({ featureId: 'v1-legacy', workflowType: 'feature' }, tmpDir);
      configureWorkflowEventStore(eventStore);

      const raw = await readRawState('v1-legacy');
      // Ensure no _esVersion (v1)
      delete raw._esVersion;
      raw.phase = 'review';
      await writeRawState('v1-legacy', raw);

      // Mock event store to fail
      const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
        new Error('store error'),
      );

      // Act — v1 should succeed even when event store fails (best-effort)
      const result = await handleCleanup({
        featureId: 'v1-legacy',
        mergeVerified: true,
      }, tmpDir);

      // Assert — v1 legacy path: state-first, events best-effort
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');

      appendSpy.mockRestore();
    });
  });
});
