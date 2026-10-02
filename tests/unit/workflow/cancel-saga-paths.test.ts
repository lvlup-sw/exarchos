import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-saga-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
});

/** Reads the raw state JSON from disk without Zod validation. */
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

describe('handleCancel saga paths', () => {
  describe('Cancel_V1LegacyWorkflow_EventAppendFails_CancelStillSucceeds', () => {
    /** A state with no `_esVersion` field is a v1 legacy workflow, which ignores event append failures. */
    it('should succeed even when event append throws for v1 (non-event-sourced) workflow', async () => {
      const eventStore = new EventStore(tmpDir);
      await handleInit({ featureId: 'v1-swallow', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('v1-swallow');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      delete rawState._esVersion;
      await writeRawState('v1-swallow', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [
          {
            sequence: 1,
            version: '1.0' as const,
            timestamp: new Date().toISOString(),
            type: 'compensation',
            trigger: 'compensation:delegate:cleanup-worktrees',
            metadata: { action: 'cleanup-worktrees' },
          },
        ],
        success: true,
        checkpoint: null,
      }));

      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Disk full'));

      const result = await handleCancel({ featureId: 'v1-swallow' }, tmpDir, eventStore);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
    });
  });

  describe('Cancel_V2Workflow_EventAppendFails_ReturnsEventAppendFailed', () => {
    /**
     * The cancellation trail for the phase change goes through `appendTrailAtomically`.
     * Thus a full store failure must also fail that call.
     */
    it('should return error with EVENT_APPEND_FAILED when event append throws for v2 workflow', async () => {
      const eventStore = new EventStore(tmpDir);
      await handleInit({ featureId: 'v2-fail', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('v2-fail');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('v2-fail', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [
          {
            sequence: 1,
            version: '1.0' as const,
            timestamp: new Date().toISOString(),
            type: 'compensation',
            trigger: 'compensation:delegate:cleanup',
            metadata: { action: 'cleanup' },
          },
        ],
        success: true,
        checkpoint: null,
      }));

      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Write error'));
      vi.spyOn(eventStore, 'appendTrailAtomically').mockRejectedValue(
        new Error('Write error'),
      );

      const result = await handleCancel({ featureId: 'v2-fail' }, tmpDir, eventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');

      const stateAfter = await readRawState('v2-fail');
      expect(stateAfter.phase).toBe('delegate');
    });
  });

  describe('Cancel_CompensationPartialFailure_ReturnsCompensationPartial', () => {
    it('should return COMPENSATION_PARTIAL when some compensation actions fail', async () => {
      await handleInit({ featureId: 'comp-partial', workflowType: 'feature' }, tmpDir, null);

      const rawState = await readRawState('comp-partial');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      await writeRawState('comp-partial', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      const mockResult: CompensationResult = {
        actions: [
          { actionId: 'synthesize:close-pr', status: 'skipped', message: 'No PR' },
          { actionId: 'delegate:delete-integration-branch', status: 'executed', message: 'Deleted' },
          { actionId: 'delegate:cleanup-worktrees', status: 'failed', message: 'Permission denied' },
          { actionId: 'delegate:delete-feature-branches', status: 'failed', message: 'Network error' },
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

      const result = await handleCancel({ featureId: 'comp-partial' }, tmpDir, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMPENSATION_PARTIAL');
      expect(result.error?.message).toContain('Permission denied');
      expect(result.error?.message).toContain('Network error');

      const stateAfter = await readRawState('comp-partial');
      expect(stateAfter.phase).toBe('delegate');
      expect(stateAfter._compensationCheckpoint).toBeDefined();
    });
  });

  describe('Cancel_TransitionEventAppend_V1Swallows_V2Throws', () => {
    it('v1 workflow swallows transition event append failures', async () => {
      const eventStore = new EventStore(tmpDir);
      await handleInit({ featureId: 'v1-trans', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('v1-trans');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      delete rawState._esVersion;
      await writeRawState('v1-trans', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('IO error'));

      const result = await handleCancel({ featureId: 'v1-trans' }, tmpDir, eventStore);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
    });

    /** The transition trail is one atomic `appendTrailAtomically` transaction, so the failure goes there. */
    it('v2 workflow propagates transition event append failures', async () => {
      const eventStore = new EventStore(tmpDir);
      await handleInit({ featureId: 'v2-trans', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('v2-trans');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('v2-trans', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      }));

      vi.spyOn(eventStore, 'appendTrailAtomically').mockRejectedValue(
        new Error('Transition IO error'),
      );

      const result = await handleCancel({ featureId: 'v2-trans' }, tmpDir, eventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('Transition IO error');

      const stateAfter = await readRawState('v2-trans');
      expect(stateAfter.phase).toBe('delegate');
    });
  });

  describe('Cancel_DryRun_ReturnsCompensationPlanWithoutExecuting', () => {
    it('should return compensation plan without mutating state or emitting events', async () => {
      const eventStore = new EventStore(tmpDir);
      await handleInit({ featureId: 'dry-run', workflowType: 'feature' }, tmpDir, eventStore);

      const rawState = await readRawState('dry-run');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('dry-run', rawState);

      const compensationModule = await import('../../../src/workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(processManaged({
        actions: [
          { actionId: 'synthesize:close-pr', status: 'dry-run', message: 'Would close PR' },
          { actionId: 'delegate:cleanup-worktrees', status: 'dry-run', message: 'Would clean up' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      }));

      const appendSpy = vi.spyOn(eventStore, 'append');

      const result = await handleCancel({ featureId: 'dry-run', dryRun: true }, tmpDir, eventStore);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.dryRun).toBe(true);
      expect(data.currentPhase).toBe('delegate');
      expect(data.wouldTransitionTo).toBe('cancelled');
      expect(data.actions).toBeDefined();
      const actions = data.actions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(2);

      expect(appendSpy).not.toHaveBeenCalled();

      const stateAfter = await readRawState('dry-run');
      expect(stateAfter.phase).toBe('delegate');
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