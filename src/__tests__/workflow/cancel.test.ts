import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCancel } from '../../workflow/cancel.js';
import { handleInit } from '../../workflow/tools.js';
import { EventStore } from '../../events/store.js';
import type { CompensationResult } from '../../workflow/compensation.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
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
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      }));

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
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      }));

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
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      // Mock the atomic phase-mutation trail append to throw (simulating a
      // storage failure). DR-7 routes the whole cancellation trail through
      // `appendTrailAtomically` — one transaction — so that is the seam a
      // storage failure surfaces at.
      vi.spyOn(eventStore, 'appendTrailAtomically').mockRejectedValue(
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

      // Deliberately NOT mocking executeCompensation: the cancellation process
      // manager now OWNS compensation-fact emission, so stubbing it out would
      // stub the very keys under assertion. The old
      // `<featureId>:cancel:compensation:<type>:<action>` scheme was replaced by
      // a digest key scoped to (featureId, cancelId, action) — collision-free
      // across concurrent cancels of the same feature.
      //
      // Seam note: cancel writes now go through the fenced atomic append
      // (`AtomicAppender.decideOnce`), which stamps the idempotency key onto the
      // event itself rather than passing it as an `append` option. Asserting
      // against the persisted stream is therefore strictly stronger than the
      // previous `append`/`appendValidated` option spy — it proves the key is
      // durable, not merely requested.

      // Act
      await handleCancel({ featureId: 'cancel-comp-keys' }, tmpDir, eventStore);

      // Assert: every compensation fact carries an idempotency key — that key is
      // what makes a resumed or retried cancellation converge instead of
      // repeating completed compensation.
      const persisted = await eventStore.query('cancel-comp-keys');
      const compensationEvents = persisted.filter((e) =>
        e.type.startsWith('cancel.compensation-'),
      );
      expect(compensationEvents.length).toBeGreaterThan(0);
      for (const event of compensationEvents) {
        expect(event.idempotencyKey, `${event.type} must be idempotency-keyed`).toBeDefined();
        expect(event.idempotencyKey).toMatch(/^cancel:[0-9a-f]{64}$/);
      }
      // Keys are distinct per (action, phase) — a shared key would collapse two
      // different compensation outcomes into one durable fact.
      const keys = compensationEvents.map((e) => e.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
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
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      // Spy on append to capture idempotency keys
      const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      // Act
      await handleCancel({ featureId: 'cancel-trans-keys' }, tmpDir, eventStore);

      // Assert: transition events have idempotency keys.
      // DR-7 — read the DURABLE stream rather than an `append` spy: the
      // cancellation trail now commits through one atomic transaction, and the
      // persisted key is the contract that actually dedups a retry.
      const transKeys = (await eventStore.query('cancel-trans-keys'))
        .map((e) => e.idempotencyKey)
        .filter((k): k is string => k !== undefined && k.includes('transition'));
      expect(transKeys.length).toBeGreaterThanOrEqual(1);
      // The transition key should match the pattern: ${featureId}:cancel:transition:${type}:${from}:cancelled
      expect(transKeys[0]).toMatch(/^cancel-trans-keys:cancel:transition:[\w.-]+:delegate:cancelled$/);
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
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      // Spy on append to capture idempotency keys
      const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
      const originalAppend = eventStore.append.bind(eventStore);
      vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
        appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
        return originalAppend(streamId, event, options);
      });

      // Act
      await handleCancel({ featureId: 'cancel-event-key' }, tmpDir, eventStore);

      // Assert: the cancel completion event has an idempotency key.
      // DR-7 — asserted against the durable stream (see the transition-key
      // test above for why the `append` spy is no longer the seam).
      const cancelKey = (await eventStore.query('cancel-event-key'))
        .map((e) => e.idempotencyKey)
        .filter((k): k is string => k !== undefined && k.includes('cancel:complete'));
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
              vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
                actions: [],
                events: [],
                success: true,
                checkpoint: null,
              }));

              // First attempt: fail the atomic cancellation-trail append.
              // DR-7 — the trail is one transaction, so this is the single
              // seam a transient storage failure surfaces at.
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

              // First cancel attempt should fail
              const result1 = await handleCancel({ featureId: 'cancel-pbt' }, propDir, eventStore);
              expect(result1.success).toBe(false);

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
 * Shape a mocked `executeCompensation` result the way the process-managed path
 * really returns it.
 *
 * Cancellation readiness requires a DURABLE outcome for every compensation
 * action — a result without `durableOutcomes` means compensation ran outside the
 * process manager, which must fail closed as COMPENSATION_PARTIAL. Mocks that
 * omit it therefore exercise the fail-closed path rather than the behaviour
 * under test. Deriving the outcomes from the mocked actions keeps the two in
 * lockstep so this cannot drift again.
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