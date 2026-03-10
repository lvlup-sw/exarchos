import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCancel, configureCancelEventStore } from '../../workflow/cancel.js';
import { handleInit, configureWorkflowEventStore } from '../../workflow/tools.js';
import { EventStore } from '../../event-store/store.js';
import type { CompensationResult } from '../../workflow/compensation.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-saga-'));
});

afterEach(async () => {
  configureCancelEventStore(null);
  configureWorkflowEventStore(null);
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Read the raw state JSON from disk, bypassing Zod validation.
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

describe('handleCancel saga paths', () => {
  // ─── T-11.1: V1 legacy swallows event append failures ─────────────────────

  describe('Cancel_V1LegacyWorkflow_EventAppendFails_CancelStillSucceeds', () => {
    it('should succeed even when event append throws for v1 (non-event-sourced) workflow', async () => {
      // Arrange: create a v1 workflow (no _esVersion field = legacy)
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureCancelEventStore(eventStore);

      await handleInit({ featureId: 'v1-swallow', workflowType: 'feature' }, tmpDir);

      // Set up as v1 (no _esVersion) in delegate phase
      const rawState = await readRawState('v1-swallow');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      // Ensure NO _esVersion — this is a v1 legacy workflow
      delete rawState._esVersion;
      await writeRawState('v1-swallow', rawState);

      // Mock compensation to succeed with events that will be bridged
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
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
      });

      // Mock event store append to throw on EVERY call
      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Disk full'));

      // Act
      const result = await handleCancel({ featureId: 'v1-swallow' }, tmpDir);

      // Assert: v1 swallows errors, cancel should succeed
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
    });
  });

  // ─── T-11.2: V2 workflow returns EVENT_APPEND_FAILED ──────────────────────

  describe('Cancel_V2Workflow_EventAppendFails_ReturnsEventAppendFailed', () => {
    it('should return error with EVENT_APPEND_FAILED when event append throws for v2 workflow', async () => {
      // Arrange: create a v2 event-sourced workflow
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureCancelEventStore(eventStore);

      await handleInit({ featureId: 'v2-fail', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('v2-fail');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('v2-fail', rawState);

      // Mock compensation to succeed with events
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
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
      });

      // Mock event store append to throw on compensation event
      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Write error'));

      // Act
      const result = await handleCancel({ featureId: 'v2-fail' }, tmpDir);

      // Assert: v2 propagates errors
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');

      // State should NOT be mutated to cancelled
      const stateAfter = await readRawState('v2-fail');
      expect(stateAfter.phase).toBe('delegate');
    });
  });

  // ─── T-11.3: Compensation partial failure returns COMPENSATION_PARTIAL ────

  describe('Cancel_CompensationPartialFailure_ReturnsCompensationPartial', () => {
    it('should return COMPENSATION_PARTIAL when some compensation actions fail', async () => {
      // Arrange: create a workflow
      await handleInit({ featureId: 'comp-partial', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('comp-partial');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      await writeRawState('comp-partial', rawState);

      // Mock compensation with mixed results (some failed)
      const compensationModule = await import('../../workflow/compensation.js');
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

      // Act
      const result = await handleCancel({ featureId: 'comp-partial' }, tmpDir);

      // Assert: should return COMPENSATION_PARTIAL error
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMPENSATION_PARTIAL');
      expect(result.error?.message).toContain('Permission denied');
      expect(result.error?.message).toContain('Network error');

      // State should still be in delegate (not cancelled) but checkpoint persisted
      const stateAfter = await readRawState('comp-partial');
      expect(stateAfter.phase).toBe('delegate');
      expect(stateAfter._compensationCheckpoint).toBeDefined();
    });
  });

  // ─── T-11.4: Transition event append — v1 swallows, v2 throws ────────────

  describe('Cancel_TransitionEventAppend_V1Swallows_V2Throws', () => {
    it('v1 workflow swallows transition event append failures', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureCancelEventStore(eventStore);

      await handleInit({ featureId: 'v1-trans', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('v1-trans');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      delete rawState._esVersion; // v1
      await writeRawState('v1-trans', rawState);

      // Mock compensation to succeed with no events
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Mock append to throw — affects transition event bridging
      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('IO error'));

      // Act
      const result = await handleCancel({ featureId: 'v1-trans' }, tmpDir);

      // Assert: v1 swallows, cancel succeeds
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
    });

    it('v2 workflow propagates transition event append failures', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureCancelEventStore(eventStore);

      await handleInit({ featureId: 'v2-trans', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('v2-trans');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('v2-trans', rawState);

      // Mock compensation to succeed with no events
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Mock append to throw on transition event
      vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Transition IO error'));

      // Act
      const result = await handleCancel({ featureId: 'v2-trans' }, tmpDir);

      // Assert: v2 propagates, cancel fails
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(result.error?.message).toContain('Transition IO error');

      // State should NOT be mutated
      const stateAfter = await readRawState('v2-trans');
      expect(stateAfter.phase).toBe('delegate');
    });
  });

  // ─── T-11.5: Dry run returns plan without executing ───────────────────────

  describe('Cancel_DryRun_ReturnsCompensationPlanWithoutExecuting', () => {
    it('should return compensation plan without mutating state or emitting events', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureCancelEventStore(eventStore);

      await handleInit({ featureId: 'dry-run', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('dry-run');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._esVersion = 2;
      await writeRawState('dry-run', rawState);

      // Mock compensation for dry run — should return dry-run status actions
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [
          { actionId: 'synthesize:close-pr', status: 'dry-run', message: 'Would close PR' },
          { actionId: 'delegate:cleanup-worktrees', status: 'dry-run', message: 'Would clean up' },
        ],
        events: [],
        success: true,
        checkpoint: null,
      });

      // Spy on event store append — should NOT be called
      const appendSpy = vi.spyOn(eventStore, 'append');

      // Act
      const result = await handleCancel({ featureId: 'dry-run', dryRun: true }, tmpDir);

      // Assert: success with dryRun data
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.dryRun).toBe(true);
      expect(data.currentPhase).toBe('delegate');
      expect(data.wouldTransitionTo).toBe('cancelled');
      expect(data.actions).toBeDefined();
      const actions = data.actions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(2);

      // Assert: no events were appended
      expect(appendSpy).not.toHaveBeenCalled();

      // Assert: state was NOT mutated
      const stateAfter = await readRawState('dry-run');
      expect(stateAfter.phase).toBe('delegate');
    });
  });
});
