import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCleanup } from '../../../src/workflow/cleanup.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { handleWorkflow } from '../../../src/workflow/composite.js';
import { EventStore } from '../../../src/events/store.js';
import type { EventStore as EventStoreType } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cleanup-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
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
      const result = await handleCleanup({ featureId: 'nonexistent', mergeVerified: true }, tmpDir, null);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });

    it('should return ALREADY_COMPLETED for completed workflow', async () => {
      await handleInit({ featureId: 'already-done', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('already-done');
      raw.phase = 'completed';
      await writeRawState('already-done', raw);

      const result = await handleCleanup({ featureId: 'already-done', mergeVerified: true }, tmpDir, null);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ALREADY_COMPLETED');
    });

    it('should return INVALID_TRANSITION for cancelled workflow', async () => {
      await handleInit({ featureId: 'cancelled-wf', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cancelled-wf');
      raw.phase = 'cancelled';
      await writeRawState('cancelled-wf', raw);

      const result = await handleCleanup({ featureId: 'cancelled-wf', mergeVerified: true }, tmpDir, null);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TRANSITION');
    });

    it('should return GUARD_FAILED when mergeVerified is false', async () => {
      await handleInit({ featureId: 'not-merged', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('not-merged');
      raw.phase = 'review';
      await writeRawState('not-merged', raw);

      const result = await handleCleanup({ featureId: 'not-merged', mergeVerified: false }, tmpDir, null);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');
    });
  });

  /**
   * The merge guard reads the evidence that is already in the state.
   * The `prUrl` input is metadata that cleanup writes after the guard, so it does not satisfy the guard.
   */
  describe('happy path', () => {
    it('should transition to completed from review phase', async () => {
      await handleInit({ featureId: 'cleanup-review', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-review');
      raw.phase = 'review';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-review', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-review',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
        mergedBranches: ['feature/task-1'],
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
    });

    /** The merge evidence is in `artifacts.pr`, so the test checks only the synthesis backfill from the input. */
    it('should backfill synthesis metadata from input', async () => {
      await handleInit({ featureId: 'cleanup-synth', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-synth');
      raw.phase = 'review';
      raw.artifacts = { ...(raw.artifacts as Record<string, unknown>), pr: 'https://github.com/test/pr/0' };
      await writeRawState('cleanup-synth', raw);

      await handleCleanup({
        featureId: 'cleanup-synth',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
        mergedBranches: ['feature/task-1', 'feature/task-2'],
      }, tmpDir, null);

      const state = await readRawState('cleanup-synth');
      const synthesis = state.synthesis as Record<string, unknown>;
      expect(synthesis.prUrl).toBe('https://github.com/test/pr/1');
      expect(synthesis.mergedBranches).toEqual(['feature/task-1', 'feature/task-2']);
    });

    /** Cleanup reads review statuses as evidence and does not change them. A review that is not approved fails the guard. */
    it('should NOT rewrite blocking review statuses (DR-8 pass-state fix retired)', async () => {
      await handleInit({ featureId: 'cleanup-reviews', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-reviews');
      raw.phase = 'review';
      raw.reviews = {
        'task-1': { status: 'in-progress' },
        'task-2': { specReview: { status: 'fail' }, qualityReview: { status: 'needs_fixes' } },
      };
      await writeRawState('cleanup-reviews', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-reviews',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');

      const state = await readRawState('cleanup-reviews');
      const reviews = state.reviews as Record<string, Record<string, unknown>>;
      expect(reviews['task-1'].status).toBe('in-progress');
      expect((reviews['task-2'].specReview as Record<string, unknown>).status).toBe('fail');
      expect((reviews['task-2'].qualityReview as Record<string, unknown>).status).toBe('needs_fixes');
      expect(state.phase).toBe('review');
    });

    it('should complete when reviews are genuinely approved', async () => {
      await handleInit({ featureId: 'cleanup-reviews-ok', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-reviews-ok');
      raw.phase = 'review';
      raw.reviews = {
        'task-1': { status: 'approved' },
        'task-2': { specReview: { status: 'approved' }, qualityReview: { status: 'approved' } },
      };
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-reviews-ok', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-reviews-ok',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((await readRawState('cleanup-reviews-ok')).phase).toBe('completed');
    });

    it('should return dryRun preview without modifying state', async () => {
      await handleInit({ featureId: 'cleanup-dry', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-dry');
      raw.phase = 'review';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-dry', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-dry',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
        dryRun: true,
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.dryRun).toBe(true);

      const state = await readRawState('cleanup-dry');
      expect(state.phase).toBe('review');
    });

    it('should work from delegate phase (feature workflow)', async () => {
      await handleInit({ featureId: 'cleanup-delegate', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-delegate');
      raw.phase = 'delegate';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-delegate', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-delegate',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
      expect((result.data as Record<string, unknown>)?.previousPhase).toBe('delegate');
    });

    it('should work for debug workflow', async () => {
      await handleInit({ featureId: 'cleanup-debug', workflowType: 'debug' }, tmpDir, null);
      const raw = await readRawState('cleanup-debug');
      raw.phase = 'investigate';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-debug', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-debug',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
    });

    it('should work for refactor workflow', async () => {
      await handleInit({ featureId: 'cleanup-refactor', workflowType: 'refactor' }, tmpDir, null);
      const raw = await readRawState('cleanup-refactor');
      raw.phase = 'overhaul-review';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-refactor', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-refactor',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');
    });
  });

  describe('event store emission', () => {
    /**
     * Cleanup emits its whole trail in one `appendTrailAtomically` call, not one `append` call for each event.
     * Each event in the trail carries its own idempotency key.
     */
    it('should emit workflow.cleanup event when event store is configured', async () => {
      const trailAppends: Array<{
        streamId: string;
        events: ReadonlyArray<{ type: string; idempotencyKey?: string }>;
        operationId: string;
      }> = [];
      const mockEventStore = {
        appendTrailAtomically: vi.fn().mockImplementation(
          async (streamId: string, events: ReadonlyArray<{ type: string; idempotencyKey?: string }>, operationId: string) => {
            trailAppends.push({ streamId, events, operationId });
          },
        ),
        append: vi.fn(),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStoreType;

      await handleInit({ featureId: 'cleanup-event-test', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-event-test');
      raw.phase = 'review';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-event-test', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-event-test',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, mockEventStore);

      expect(result.success).toBe(true);
      expect(mockEventStore.appendTrailAtomically).toHaveBeenCalledTimes(1);
      expect(mockEventStore.append).not.toHaveBeenCalled();
      const trail = trailAppends[0];
      expect(trail?.streamId).toBe('cleanup-event-test');
      const cleanupEvent = trail?.events.find((e) => e.type === 'workflow.cleanup');
      expect(cleanupEvent).toBeDefined();
      for (const evt of trail?.events ?? []) {
        expect(evt.idempotencyKey).toContain('cleanup-event-test:cleanup:');
      }
    });

    it('should abort cleanup when the atomic trail append fails (v2 event-first)', async () => {
      const mockEventStore = {
        appendTrailAtomically: vi.fn().mockRejectedValue(new Error('store error')),
        append: vi.fn(),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStoreType;

      await handleInit({ featureId: 'cleanup-store-fail', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('cleanup-store-fail');
      raw.phase = 'review';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('cleanup-store-fail', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-store-fail',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, mockEventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('store error');

      const state = await readRawState('cleanup-store-fail');
      expect(state.phase).toBe('review');

    });
  });

  describe('composite routing', () => {
    /** A `GUARD_FAILED` error, not `UNKNOWN_ACTION`, shows that the composite routes the action to `handleCleanup`. */
    it('should route cleanup action to handleCleanup', async () => {
      await handleInit({ featureId: 'composite-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleWorkflow({
        action: 'cleanup',
        featureId: 'composite-test',
        mergeVerified: false,
      }, makeCtx(tmpDir));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');
    });
  });

  describe('ES v2 event-first cleanup', () => {
    let eventStore: EventStore;

    beforeEach(() => {
      eventStore = new EventStore(tmpDir);
    });

    afterEach(() => {
    });

    /**
     * The HSM transition and the explicit cleanup event both have the type `workflow.cleanup`, so the stream holds at least two.
     * Each event timestamp must be within 1000 ms of the state `updatedAt`, which is a wide margin for CI.
     */
    it('HandleCleanup_EsVersion2_EmitsEventsBeforeStateWrite', async () => {
      await handleInit({ featureId: 'v2-event-order', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('v2-event-order');
      raw.phase = 'synthesize';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/42' };
      await writeRawState('v2-event-order', raw);

      const result = await handleCleanup({
        featureId: 'v2-event-order',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/42',
        mergedBranches: ['feature/task-1'],
      }, tmpDir, eventStore);

      expect(result.success).toBe(true);

      const allEvents = await eventStore.query('v2-event-order');
      const cleanupEvents = allEvents.filter(e => e.type === 'workflow.cleanup');
      const patchEvents = allEvents.filter(e => e.type === 'state.patched');

      expect(cleanupEvents.length).toBeGreaterThanOrEqual(2);
      expect(patchEvents.length).toBeGreaterThanOrEqual(1);

      const state = await readRawState('v2-event-order');
      expect(state.phase).toBe('completed');

      const updatedAt = new Date(state.updatedAt as string).getTime();
      for (const evt of [...cleanupEvents, ...patchEvents]) {
        const eventTime = new Date(evt.timestamp).getTime();
        expect(Math.abs(eventTime - updatedAt)).toBeLessThan(1000);
      }
    });

    /** A second cleanup fails with `ALREADY_COMPLETED` and appends no events. */
    it('HandleCleanup_EsVersion2_IdempotencyKeysPresent', async () => {
      await handleInit({ featureId: 'v2-idemp', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('v2-idemp');
      raw.phase = 'synthesize';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('v2-idemp', raw);

      await handleCleanup({
        featureId: 'v2-idemp',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, eventStore);

      const allEvents = await eventStore.query('v2-idemp');
      const cleanupRelated = allEvents.filter(e =>
        e.type === 'state.patched' ||
        e.type === 'workflow.transition' ||
        e.type === 'workflow.cleanup'
      );

      expect(cleanupRelated.length).toBeGreaterThanOrEqual(2);
      for (const evt of cleanupRelated) {
        expect(evt.idempotencyKey).toBeDefined();
        expect(evt.idempotencyKey).toContain('v2-idemp:cleanup:');
      }

      const eventCountBefore = allEvents.length;
      const secondResult = await handleCleanup({
        featureId: 'v2-idemp',
        mergeVerified: true,
      }, tmpDir, eventStore);
      expect(secondResult.success).toBe(false);
      expect(secondResult.error?.code).toBe('ALREADY_COMPLETED');

      const eventsAfter = await eventStore.query('v2-idemp');
      expect(eventsAfter.length).toBe(eventCountBefore);
    });

    it('HandleCleanup_EsVersion2_EventFailure_AbortsStateWrite', async () => {
      await handleInit({ featureId: 'v2-evt-fail', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('v2-evt-fail');
      raw.phase = 'synthesize';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('v2-evt-fail', raw);

      const appendSpy = vi.spyOn(eventStore, 'appendTrailAtomically').mockRejectedValue(
        new Error('Disk full'),
      );

      const result = await handleCleanup({
        featureId: 'v2-evt-fail',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, eventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('Disk full');

      const state = await readRawState('v2-evt-fail');
      expect(state.phase).toBe('synthesize');

      appendSpy.mockRestore();
    });

    /**
     * The fixture approves the reviews, because cleanup does not approve them.
     * The merge evidence is in `artifacts.pr`, so the `prUrl` input is only the backfill under test.
     * The `state.patched` event holds the synthesis or artifacts backfill and does not patch `reviews`.
     */
    it('HandleCleanup_EsVersion2_EmitsStatePatchedForBackfill', async () => {
      await handleInit({ featureId: 'v2-patch', workflowType: 'feature' }, tmpDir, null);
      const raw = await readRawState('v2-patch');
      raw.phase = 'review';
      raw.reviews = {
        'task-1': { status: 'approved' },
      };
      raw.artifacts = { ...(raw.artifacts as Record<string, unknown>), pr: 'https://github.com/test/pr/0' };
      await writeRawState('v2-patch', raw);

      const result = await handleCleanup({
        featureId: 'v2-patch',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/99',
        mergedBranches: ['feature/branch-a', 'feature/branch-b'],
      }, tmpDir, eventStore);

      expect(result.success).toBe(true);

      const allEvents = await eventStore.query('v2-patch');
      const patchEvents = allEvents.filter(e => e.type === 'state.patched');

      expect(patchEvents.length).toBeGreaterThanOrEqual(1);
      const patchData = patchEvents[0].data as Record<string, unknown>;
      expect(patchData.featureId).toBe('v2-patch');
      expect(patchData.fields).toBeDefined();
      const fields = patchData.fields as string[];
      expect(fields.includes('synthesis') || fields.includes('artifacts')).toBe(true);
      expect(fields).not.toContain('reviews');
      const patch = patchData.patch as Record<string, unknown>;
      expect(patch).toBeDefined();
      expect(patch.reviews).toBeUndefined();
      if (patch.synthesis) {
        const synthPatch = patch.synthesis as Record<string, unknown>;
        expect(synthPatch.prUrl).toBe('https://github.com/test/pr/99');
        expect(synthPatch.mergedBranches).toEqual(['feature/branch-a', 'feature/branch-b']);
      }
    });

    /** A state with no `_esVersion` field is a v1 legacy workflow. */
    it('HandleCleanup_V1Legacy_StillWorksWithBestEffortEvents', async () => {
      await handleInit({ featureId: 'v1-legacy', workflowType: 'feature' }, tmpDir, null);

      const raw = await readRawState('v1-legacy');
      delete raw._esVersion;
      raw.phase = 'review';
      raw.synthesis = { ...(raw.synthesis as Record<string, unknown>), prUrl: 'https://github.com/test/pr/1' };
      await writeRawState('v1-legacy', raw);

      const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
        new Error('store error'),
      );

      const result = await handleCleanup({
        featureId: 'v1-legacy',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
      }, tmpDir, null);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');

      appendSpy.mockRestore();
    });
  });
});
