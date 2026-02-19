import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCleanup, configureCleanupEventStore } from '../../workflow/cleanup.js';
import { handleInit } from '../../workflow/tools.js';
import { handleWorkflow } from '../../workflow/composite.js';
import type { EventStore } from '../../event-store/store.js';

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
          type: 'workflow.transition',
          streamId: 'cleanup-event-test',
          schemaVersion: '1.0',
        }),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore;

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
      expect(mockEventStore.append).toHaveBeenCalledWith(
        'cleanup-event-test',
        expect.objectContaining({
          data: expect.objectContaining({
            featureId: 'cleanup-event-test',
          }),
        }),
      );

      configureCleanupEventStore(null);
    });

    it('should not break cleanup when event store append fails', async () => {
      const mockEventStore = {
        append: vi.fn().mockRejectedValue(new Error('store error')),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore;

      configureCleanupEventStore(mockEventStore);

      await handleInit({ featureId: 'cleanup-store-fail', workflowType: 'feature' }, tmpDir);
      const raw = await readRawState('cleanup-store-fail');
      raw.phase = 'review';
      await writeRawState('cleanup-store-fail', raw);

      const result = await handleCleanup({
        featureId: 'cleanup-store-fail',
        mergeVerified: true,
      }, tmpDir);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)?.phase).toBe('completed');

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
});
