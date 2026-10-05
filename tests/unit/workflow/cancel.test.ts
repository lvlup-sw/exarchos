import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCancel } from '../../../src/workflow/cancel.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import type { CompensationResult } from '../../../src/workflow/compensation.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
});

/** Reads the raw state JSON from disk without Zod validation, so fields outside the schema stay. */
async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
}

/** Writes the raw state JSON to disk without Zod validation. */
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
      await handleInit({ featureId: 'ckpt-partial', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-partial');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      await writeRawState('ckpt-partial', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
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

      const result = await handleCancel({ featureId: 'ckpt-partial' }, tmpDir, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMPENSATION_PARTIAL');

      const stateAfter = await readRawState('ckpt-partial');
      expect(stateAfter._compensationCheckpoint).toBeDefined();
      const checkpoint = stateAfter._compensationCheckpoint as { completedActions: string[] };
      expect(checkpoint.completedActions).toContain('synthesize:close-pr');
      expect(checkpoint.completedActions).toContain('delegate:delete-integration-branch');
    });

    it('should pass existing checkpoint to compensation on retry', async () => {
      await handleInit({ featureId: 'ckpt-retry', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-retry');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr', 'delegate:delete-integration-branch'],
      };
      await writeRawState('ckpt-retry', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
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

      await handleCancel({ featureId: 'ckpt-retry' }, tmpDir, null);

      expect(capturedOptions).toBeDefined();
      const opts = capturedOptions as { checkpoint?: { completedActions: readonly string[] } };
      expect(opts.checkpoint).toBeDefined();
      expect(opts.checkpoint?.completedActions).toContain('synthesize:close-pr');
      expect(opts.checkpoint?.completedActions).toContain('delegate:delete-integration-branch');
    });

    it('should clear checkpoint after successful cancellation', async () => {
      await handleInit({ featureId: 'ckpt-clear', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-clear');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };
      await writeRawState('ckpt-clear', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      }));

      const result = await handleCancel({ featureId: 'ckpt-clear' }, tmpDir, null);

      expect(result.success).toBe(true);

      const stateAfter = await readRawState('ckpt-clear');
      expect(stateAfter._compensationCheckpoint).toBeUndefined();
    });

    it('should set _compensationCheckpoint to null in state on successful compensation', async () => {
      await handleInit({ featureId: 'ckpt-null', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('ckpt-null');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };
      await writeRawState('ckpt-null', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      }));

      const result = await handleCancel({ featureId: 'ckpt-null' }, tmpDir, null);

      expect(result.success).toBe(true);

      const stateAfter = await readRawState('ckpt-null');
      expect(stateAfter).not.toHaveProperty('_compensationCheckpoint');
    });
  });

  describe('event-first error propagation (v2)', () => {
    /** The whole cancellation trail commits in one `appendTrailAtomically` transaction, so the test injects the storage failure there. */
    it('handleCancel_EventAppendFails_ReturnsErrorNotMutatesState', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-efail', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-efail');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-efail', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      vi.spyOn(eventStore, 'appendTrailAtomically').mockRejectedValue(
        new Error('Disk full'),
      );

      const result = await handleCancel({ featureId: 'cancel-efail' }, tmpDir, eventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('Disk full');

      const stateAfter = await readRawState('cancel-efail');
      expect(stateAfter.phase).toBe('delegate');
    });
  });

  describe('cancel event idempotency keys', () => {
    /**
     * The test does not mock `executeCompensation`, because the process manager emits the compensation facts and their keys.
     * `AtomicAppender.decideOnce` stamps each key on the event, so the test reads the persisted stream.
     * Two compensation outcomes must not share a key, or they merge into one durable fact.
     */
    it('handleCancel_CompensationEvents_HaveIdempotencyKeys', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-comp-keys', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-comp-keys');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-comp-keys', rawState);

      await handleCancel({ featureId: 'cancel-comp-keys' }, tmpDir, eventStore);

      const persisted = await eventStore.query('cancel-comp-keys');
      const compensationEvents = persisted.filter((e) =>
        e.type.startsWith('cancel.compensation-'),
      );
      expect(compensationEvents.length).toBeGreaterThan(0);
      for (const event of compensationEvents) {
        expect(event.idempotencyKey, `${event.type} must be idempotency-keyed`).toBeDefined();
        expect(event.idempotencyKey).toMatch(/^cancel:[0-9a-f]{64}$/);
      }
      const keys = compensationEvents.map((e) => e.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    /**
     * The cancellation trail commits in one atomic transaction, and the persisted key dedups a retry.
     * Thus the test reads the durable stream, not the `append` spy.
     */
    it('handleCancel_TransitionEvents_HaveIdempotencyKeys', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-trans-keys', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-trans-keys');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-trans-keys', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      await handleCancel({ featureId: 'cancel-trans-keys' }, tmpDir, eventStore);

      const transKeys = (await eventStore.query('cancel-trans-keys'))
        .map((e) => e.idempotencyKey)
        .filter((k): k is string => k !== undefined && k.includes('transition'));
      expect(transKeys.length).toBeGreaterThanOrEqual(1);
      expect(transKeys[0]).toMatch(/^cancel-trans-keys:cancel:transition:[\w.-]+:delegate:cancelled$/);
    });

    /** The test reads the durable stream for the same reason as the transition-key test. */
    it('handleCancel_CancelEvent_HasIdempotencyKey', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'cancel-event-key', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('cancel-event-key');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('cancel-event-key', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      await handleCancel({ featureId: 'cancel-event-key' }, tmpDir, eventStore);

      const cancelKey = (await eventStore.query('cancel-event-key'))
        .map((e) => e.idempotencyKey)
        .filter((k): k is string => k !== undefined && k.includes('cancel:complete'));
      expect(cancelKey.length).toBe(1);
      expect(cancelKey[0]).toBe('cancel-event-key:cancel:complete');
    });
  });

  describe('cancel retry idempotency (property)', () => {
    /**
     * In each run, the first attempt fails the atomic trail append.
     * The retry succeeds, and the stream holds no duplicate events.
     */
    it('handleCancel_RetryAfterFailure_NoDuplicateEvents', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('ideate', 'plan', 'delegate', 'review', 'synthesize'),
          async (phase) => {
            const propDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-pbt-'));
            try {
              const eventStore = new EventStore(propDir);

              await handleInit({ featureId: 'cancel-pbt', workflowType: 'feature' }, propDir, eventStore);

              const stateFile = path.join(propDir, 'cancel-pbt.state.json');
              const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
              rawState.phase = phase;
              rawState._history = { feature: phase };
              rawState._esVersion = 2;
              await fs.writeFile(stateFile, JSON.stringify(rawState, null, 2), 'utf-8');

              const compensationModule = await import('../../../src/workflow/compensation.js');
              vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
                actions: [],
                events: [],
                success: true,
                checkpoint: null,
              }));

              let trailCalls = 0;
              const originalTrail = eventStore.appendTrailAtomically.bind(eventStore);
              vi.spyOn(eventStore, 'appendTrailAtomically').mockImplementation(
                async (streamId, events, operationId) => {
                  trailCalls++;
                  if (trailCalls === 1) {
                    throw new Error('Transient failure');
                  }
                  return originalTrail(streamId, events, operationId);
                },
              );

              const result1 = await handleCancel({ featureId: 'cancel-pbt' }, propDir, eventStore);
              expect(result1.success).toBe(false);

              const result2 = await handleCancel({ featureId: 'cancel-pbt' }, propDir, eventStore);
              expect(result2.success).toBe(true);

              const allEvents = await eventStore.query('cancel-pbt');
              const eventKeys = allEvents
                .map((e) => `${e.type}:${JSON.stringify(e.data)}`)
                .sort();
              const uniqueKeys = [...new Set(eventKeys)];
              expect(eventKeys).toEqual(uniqueKeys);
            } finally {
              vi.restoreAllMocks();
              await rmrfAsync(propDir);
            }
          },
        ),
        { numRuns: 5 },
      );
    });
  });
});

/**
 * Adds `durableOutcomes` to a mocked `executeCompensation` result, in the shape of the process-managed path.
 * The outcomes come from the mocked actions, so the two always agree.
 */
function processManaged<T extends { actions: readonly { actionId: string }[] }>(
  result: T,
): T & {
  durableOutcomes: {
    completedActionIds: readonly string[];
    outcomeSequences: readonly number[];
  };
} {
  return {
    ...result,
    durableOutcomes: {
      completedActionIds: result.actions.map((a) => a.actionId),
      outcomeSequences: result.actions.map((_, i) => i + 1),
    },
  };
}