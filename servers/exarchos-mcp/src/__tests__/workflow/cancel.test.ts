import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCancel } from '../../workflow/cancel.js';
import { handleInit } from '../../workflow/tools.js';
import { EventStore } from '../../event-store/store.js';
import type { CompensationResult } from '../../workflow/compensation.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Read the raw state JSON from disk, bypassing Zod validation.
 * This preserves non-schema fields that Zod might strip.
 */
async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
}

/**
 * Write the raw state JSON to disk, bypassing Zod validation.
 */
async function writeRawState(
  featureId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

describe('handleCancel', () => {
  describe('compensation checkpoint persistence', () => {
    it('should persist compensation checkpoint on partial failure', async () => {
      // Arrange: create a workflow in delegate phase
      await handleInit({ featureId: 'ckpt-partial', workflowType: 'feature' }, tmpDir, null);

      // Advance to delegate phase by writing raw state
      const rawState = await readRawState('ckpt-partial');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      await writeRawState('ckpt-partial', rawState);

      // Mock executeCompensation to simulate partial failure
      const compensationModule = await import('../../workflow/compensation.js');
      const mockResult: CompensationResult = {
        actions: [
          { actionId: 'synthesize:close-pr', status: 'skipped', message: 'No PR to close' },
          { actionId: 'delegate:delete-integration-branch', status: 'executed', message: 'Deleted branch' },
          { actionId: 'delegate:cleanup-worktrees', status: 'failed', message: 'Failed to clean up' },
        ],
        events: [],
        success: false,
        errorCode: 'COMPENSATION_PARTIAL',
        checkpoint: {
          completedActions: [
            'synthesize:close-pr',
            'delegate:delete-integration-branch',
          ],
        },
      };
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(mockResult);

      // Act
      const result = await handleCancel({ featureId: 'ckpt-partial' }, tmpDir, null);

      // Assert: cancel should report partial failure
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMPENSATION_PARTIAL');

      // Assert: state file should contain _compensationCheckpoint
      const stateAfter = await readRawState('ckpt-partial');
      expect(stateAfter._compensationCheckpoint).toBeDefined();
      const checkpoint = stateAfter._compensationCheckpoint as { completedActions: string[] };
      expect(checkpoint.completedActions).toContain('synthesize:close-pr');
      expect(checkpoint.completedActions).toContain('delegate:delete-integration-branch');
    });

    it('should pass existing checkpoint to compensation on retry', async () => {
      // Arrange: create a workflow with an existing _compensationCheckpoint
      await handleInit({ featureId: 'ckpt-retry', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-retry');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr', 'delegate:delete-integration-branch'],
      };
      await writeRawState('ckpt-retry', rawState);

      // Mock executeCompensation to capture the checkpoint parameter
      const compensationModule = await import('../../workflow/compensation.js');
      let capturedOptions: unknown = null;
      vi.spyOn(compensationModule, 'executeCompensation').mockImplementation(
        async (_state, _phase, _events, _seq, options) => {
          capturedOptions = options;
          return {
            actions: [
              { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Cleaned up' },
              { actionId: 'delegate:delete-feature-branches', status: 'executed', message: 'Deleted branches' },
            ],
            events: [],
            success: true,
            checkpoint: null,
          };
        },
      );

      // Act
      await handleCancel({ featureId: 'ckpt-retry' }, tmpDir, null);

      // Assert: existing checkpoint was passed to executeCompensation
      expect(capturedOptions).toBeDefined();
      const opts = capturedOptions as { checkpoint?: { completedActions: readonly string[] } };
      expect(opts.checkpoint).toBeDefined();
      expect(opts.checkpoint?.completedActions).toContain('synthesize:close-pr');
      expect(opts.checkpoint?.completedActions).toContain('delegate:delete-integration-branch');
    });

    it('should clear checkpoint after successful cancellation', async () => {
      // Arrange: create a workflow with an existing _compensationCheckpoint
      await handleInit({ featureId: 'ckpt-clear', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-clear');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };
      await writeRawState('ckpt-clear', rawState);

      // Mock executeCompensation to return success (null checkpoint)
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Act
      const result = await handleCancel({ featureId: 'ckpt-clear' }, tmpDir, null);

      // Assert: cancel should succeed
      expect(result.success).toBe(true);

      // Assert: state file should NOT contain _compensationCheckpoint
      const stateAfter = await readRawState('ckpt-clear');
      expect(stateAfter._compensationCheckpoint).toBeUndefined();
    });

    // ─── T5: Clean _compensationCheckpoint from state after cancel (ARCH-5) ──

    it('should set _compensationCheckpoint to null in state on successful compensation', async () => {
      // Arrange: create a workflow with _compensationCheckpoint from a prior partial failure
      await handleInit({ featureId: 'ckpt-null', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-null');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };
      await writeRawState('ckpt-null', rawState);

      // Mock executeCompensation to return success
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Act
      const result = await handleCancel({ featureId: 'ckpt-null' }, tmpDir, null);

      // Assert: cancel should succeed
      expect(result.success).toBe(true);

      // Assert: the raw state on disk should not have _compensationCheckpoint
      const stateAfter = await readRawState('ckpt-null');
      expect(stateAfter).not.toHaveProperty('_compensationCheckpoint');
    });
  });

  // ─── F-CANCEL-1: Event-first violation — error propagation ────────────────

  describe('event-first error propagation (v2)', () => {
    it('handleCancel_EventAppendFails_ReturnsErrorNotMutatesState', async () => {
      // Arrange: create a v2 (event-sourced) workflow in delegate phase
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-efail', workflowType: 'feature' }, tmpDir, eventStore);

      // Set up as v2 event-sourced workflow in delegate phase
      const rawState = await readRawState('cancel-efail');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-efail', rawState);

      // Mock compensation to succeed (no partial failure)
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Mock event store append to throw (simulating JSONL failure)
      vi.spyOn(eventStore, 'append').mockRejectedValue(
        new Error('Disk full'),
      );

      // Act
      const result = await handleCancel({ featureId: 'cancel-efail' }, tmpDir, eventStore);

      // Assert: should return error, NOT succeed
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('Disk full');

      // Assert: state should NOT be mutated to 'cancelled'
      const stateAfter = await readRawState('cancel-efail');
      expect(stateAfter.phase).toBe('delegate');
    });
  });

  // ─── F-CANCEL-2: Idempotency keys on cancel events ────────────────────────

  describe('cancel event idempotency keys', () => {
    it('handleCancel_CompensationEvents_HaveIdempotencyKeys', async () => {
      // Arrange: create a v2 workflow with compensation events
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-comp-keys', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-comp-keys');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-comp-keys', rawState);

      // Mock compensation to return events
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
          { actionId: 'delegate:delete-branches', status: 'executed', message: 'Done' },
        ],
        events: [
          { type: 'compensation', timestamp: new Date().toISOString(), metadata: { action: 'cleanup-worktrees' } },
          { type: 'compensation', timestamp: new Date().toISOString(), metadata: { action: 'delete-branches' } },
        ],
        success: true,
        checkpoint: null,
      });

      // Spy on append to capture idempotency keys
      const appendCalls: Array<{ idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      // Act
      await handleCancel({ featureId: 'cancel-comp-keys' }, tmpDir, eventStore);

      // Assert: compensation events have idempotency keys matching the pattern
      // The first two append calls after init should be compensation events
      // Filter for compensation-related calls
      const compKeys = appendCalls
        .map((c) => c.idempotencyKey)
        .filter((k): k is string => k !== undefined && k.includes('compensation'));
      expect(compKeys.length).toBe(2);
      expect(compKeys[0]).toBe('cancel-comp-keys:cancel:compensation:compensation:cleanup-worktrees');
      expect(compKeys[1]).toBe('cancel-comp-keys:cancel:compensation:compensation:delete-branches');
    });

    it('handleCancel_TransitionEvents_HaveIdempotencyKeys', async () => {
      // Arrange: create a v2 workflow
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-trans-keys', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-trans-keys');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-trans-keys', rawState);

      // Mock compensation to succeed with no events
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Spy on append to capture idempotency keys
      const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      // Act
      await handleCancel({ featureId: 'cancel-trans-keys' }, tmpDir, eventStore);

      // Assert: transition events have idempotency keys
      const transKeys = appendCalls
        .filter((c) => c.idempotencyKey?.includes('transition'))
        .map((c) => c.idempotencyKey);
      expect(transKeys.length).toBeGreaterThanOrEqual(1);
      // The transition key should match the pattern: ${featureId}:cancel:transition:${type}:${from}:cancelled
      expect(transKeys[0]).toMatch(/^cancel-trans-keys:cancel:transition:\w+:delegate:cancelled$/);
    });

    it('handleCancel_CancelEvent_HasIdempotencyKey', async () => {
      // Arrange: create a v2 workflow
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-event-key', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-event-key');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-event-key', rawState);

      // Mock compensation to succeed
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Spy on append to capture idempotency keys
      const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      // Act
      await handleCancel({ featureId: 'cancel-event-key' }, tmpDir, eventStore);

      // Assert: the cancel completion event has an idempotency key
      const cancelKey = appendCalls
        .filter((c) => c.idempotencyKey?.includes('cancel:complete'))
        .map((c) => c.idempotencyKey);
      expect(cancelKey.length).toBe(1);
      expect(cancelKey[0]).toBe('cancel-event-key:cancel:complete');
    });
  });

  // ─── Property test: retry after failure produces no duplicate events ────────

  describe('cancel retry idempotency (property)', () => {
    it('handleCancel_RetryAfterFailure_NoDuplicateEvents', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('ideate', 'plan', 'delegate', 'review', 'synthesize'),
          async (phase) => {
            // Use a unique dir per property run
            const propDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-pbt-'));
            try {
              const eventStore = new EventStore(propDir);

              await handleInit({ featureId: 'cancel-pbt', workflowType: 'feature' }, propDir, eventStore);

              // Read/write raw state using propDir directly
              const stateFile = path.join(propDir, 'cancel-pbt.state.json');
              const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
              rawState.phase = phase;
              rawState._history = { feature: phase };
              rawState._esVersion = 2;
              await fs.writeFile(stateFile, JSON.stringify(rawState, null, 2), 'utf-8');

              // Mock compensation
              const compensationModule = await import('../../workflow/compensation.js');
              vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
                actions: [],
                events: [],
                success: true,
                checkpoint: null,
              });

              // First attempt: fail event append on the first call within cancel
              let callCount = 0;
              const originalAppend = eventStore.append.bind(eventStore);
              vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
                callCount++;
                // Fail on the 1st cancel-related append
                if (callCount === 1) {
                  throw new Error('Transient failure');
                }
                return originalAppend(streamId, event, options);
              });

              // First cancel attempt should fail
              const result1 = await handleCancel({ featureId: 'cancel-pbt' }, propDir, eventStore);
              expect(result1.success).toBe(false);

              // Reset mock to let retry succeed
              vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
                return originalAppend(streamId, event, options);
              });

              // Retry cancel — state should not have been mutated by first attempt
              const result2 = await handleCancel({ featureId: 'cancel-pbt' }, propDir, eventStore);
              expect(result2.success).toBe(true);

              // Verify no duplicate events in stream
              const allEvents = await eventStore.query('cancel-pbt');
              const eventKeys = allEvents
                .map((e) => `${e.type}:${JSON.stringify(e.data)}`)
                .sort();
              const uniqueKeys = [...new Set(eventKeys)];
              expect(eventKeys).toEqual(uniqueKeys);
            } finally {
              vi.restoreAllMocks();
              await fs.rm(propDir, { recursive: true, force: true });
            }
          },
        ),
        { numRuns: 5 },
      );
    });
  });
});
