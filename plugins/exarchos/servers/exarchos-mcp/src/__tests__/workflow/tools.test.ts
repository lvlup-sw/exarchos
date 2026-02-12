import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleInit,
  handleList,
  handleGet,
  handleSet,
  handleSummary,
  handleReconcile,
  handleNextAction,
  handleTransitions,
  handleCancel,
  handleCheckpoint,
  configureWorkflowEventStore,
} from '../../workflow/tools.js';
import { initStateFile, readStateFile, writeStateFile } from '../../workflow/state-store.js';
import { EventStore } from '../../event-store/store.js';
import type { WorkflowState } from '../../workflow/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tools-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Core Tools', () => {
  // ─── ToolInit ───────────────────────────────────────────────────────────────

  describe('ToolInit_NewFeature_CreatesStateFile', () => {
    it('should create a new state file with correct defaults', async () => {
      const result = await handleInit(
        { featureId: 'my-feature', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result._meta).toEqual({ checkpointAdvised: false });

      // Verify state was created on disk
      const state = await readStateFile(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('ideate');

      // Verify slim response contains identity fields
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('my-feature');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('ideate');

      // Slim response should NOT include heavy fields
      expect(data.tasks).toBeUndefined();
      expect(data._events).toBeUndefined();
    });
  });

  describe('ToolInit_ExistingFeature_ReturnsStateAlreadyExists', () => {
    it('should return error if state already exists', async () => {
      // Create it first
      await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
      );

      // Try to create again
      const result = await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('STATE_ALREADY_EXISTS');
    });
  });

  // ─── ToolList ───────────────────────────────────────────────────────────────

  describe('ToolList_ActiveWorkflows_ReturnsWithStaleness', () => {
    it('should return all workflows with staleness info', async () => {
      // Create multiple workflows
      await handleInit({ featureId: 'feat-a', workflowType: 'feature' }, tmpDir);
      await handleInit({ featureId: 'feat-b', workflowType: 'debug' }, tmpDir);

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);

      // Each entry should have staleness info (no _meta block)
      for (const entry of data) {
        expect(entry.featureId).toBeDefined();
        expect(entry.stale).toBeDefined();
        expect(entry._meta).toBeUndefined();
      }
    });
  });

  // ─── ToolGet ────────────────────────────────────────────────────────────────

  describe('ToolGet_DotPathQuery_ReturnsValue', () => {
    it('should return the nested value for a dot-path query', async () => {
      await handleInit({ featureId: 'get-test', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'get-test', query: 'artifacts.design' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeNull(); // design is null by default
      expect(result._meta).toBeDefined();
    });

    it('should return the full state when no query is provided', async () => {
      await handleInit({ featureId: 'get-full', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'get-full' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('get-full');
      expect(data.phase).toBe('ideate');
    });
  });

  describe('ToolGet_InternalField_ReturnsValue', () => {
    it('should be able to read internal fields like _history and _events', async () => {
      await handleInit({ featureId: 'internal-test', workflowType: 'feature' }, tmpDir);

      const historyResult = await handleGet(
        { featureId: 'internal-test', query: '_history' },
        tmpDir,
      );
      expect(historyResult.success).toBe(true);
      expect(historyResult.data).toEqual({});

      const eventsResult = await handleGet(
        { featureId: 'internal-test', query: '_events' },
        tmpDir,
      );
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toEqual([]);
    });
  });

  describe('handleGet_NoQuery_ExcludesInternalFields', () => {
    it('should not include _events, _eventSequence, or _history in response data', async () => {
      await handleInit({ featureId: 'strip-test', workflowType: 'feature' }, tmpDir);

      // Do a set to generate some events
      await handleSet(
        { featureId: 'strip-test', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );

      const result = await handleGet(
        { featureId: 'strip-test' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // Core fields should still be present
      expect(data.featureId).toBe('strip-test');
      expect(data.phase).toBe('ideate');

      // Internal fields should be stripped
      expect(data._events).toBeUndefined();
      expect(data._eventSequence).toBeUndefined();
      expect(data._history).toBeUndefined();
    });
  });

  describe('handleGet_NoQuery_IncludesMetaEventSummary', () => {
    it('should include eventCount and recentEvents in _meta', async () => {
      await handleInit({ featureId: 'meta-summary', workflowType: 'feature' }, tmpDir);

      // Set design artifact and transition to plan to generate events
      await handleSet(
        { featureId: 'meta-summary', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'meta-summary', phase: 'plan' },
        tmpDir,
      );

      const result = await handleGet(
        { featureId: 'meta-summary' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(typeof meta.eventCount).toBe('number');
      expect(meta.eventCount).toBeGreaterThan(0);
      expect(Array.isArray(meta.recentEvents)).toBe(true);

      const recentEvents = meta.recentEvents as Array<Record<string, unknown>>;
      expect(recentEvents.length).toBeGreaterThan(0);
      expect(recentEvents.length).toBeLessThanOrEqual(3);
      // Each recent event should have type and timestamp
      for (const event of recentEvents) {
        expect(typeof event.type).toBe('string');
        expect(typeof event.timestamp).toBe('string');
      }
    });
  });

  describe('handleGet_QueryEventsExplicitly_StillWorks', () => {
    it('should return _events when explicitly queried', async () => {
      await handleInit({ featureId: 'query-events', workflowType: 'feature' }, tmpDir);

      // Generate some events
      await handleSet(
        { featureId: 'query-events', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'query-events', phase: 'plan' },
        tmpDir,
      );

      const result = await handleGet(
        { featureId: 'query-events', query: '_events' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const events = result.data as Array<Record<string, unknown>>;
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // ─── Fast-Path Query Tests ─────────────────────────────────────────────────

  describe('handleGet_FastPath_Phase_ReturnsCorrectValue', () => {
    it('should return the phase value via fast path without full Zod validation', async () => {
      await handleInit({ featureId: 'fast-phase', workflowType: 'feature' }, tmpDir);

      // Spy on readStateFile to verify fast path skips it
      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-phase', query: 'phase' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('ideate');
      // Fast path should NOT call readStateFile
      expect(readSpy).not.toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_FastPath_FeatureId_ReturnsCorrectValue', () => {
    it('should return the featureId value via fast path', async () => {
      await handleInit({ featureId: 'fast-fid', workflowType: 'feature' }, tmpDir);

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-fid', query: 'featureId' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('fast-fid');
      expect(readSpy).not.toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_FastPath_IncludesMeta', () => {
    it('should include _meta.checkpointAdvised in fast-path responses', async () => {
      await handleInit({ featureId: 'fast-meta', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'fast-meta', query: 'phase' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('ideate');
      expect(result._meta).toBeDefined();
      expect(result._meta?.checkpointAdvised).toBe(false);
    });

    it('should return consistent _meta shape between fast-path and normal path', async () => {
      await handleInit({ featureId: 'fast-meta-consistent', workflowType: 'feature' }, tmpDir);

      // Fast-path query
      const fastResult = await handleGet(
        { featureId: 'fast-meta-consistent', query: 'phase' },
        tmpDir,
      );

      // Normal path query (dot-path, not in FAST_PATH_FIELDS)
      const normalResult = await handleGet(
        { featureId: 'fast-meta-consistent', query: 'artifacts.design' },
        tmpDir,
      );

      // Both should have _meta with checkpointAdvised
      expect(fastResult._meta).toBeDefined();
      expect(normalResult._meta).toBeDefined();
      expect(typeof fastResult._meta?.checkpointAdvised).toBe('boolean');
      expect(typeof normalResult._meta?.checkpointAdvised).toBe('boolean');
    });
  });

  describe('handleGet_FastPath_FallsThrough_WhenFieldMissing', () => {
    it('should fall through to full validation when fast-path field is missing from state', async () => {
      await handleInit({ featureId: 'fast-missing-field', workflowType: 'feature' }, tmpDir);

      // Manually corrupt the state file by removing the 'track' field
      // (track is in FAST_PATH_FIELDS but may not exist on feature workflows)
      const stateFile = path.join(tmpDir, 'fast-missing-field.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw.track;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-missing-field', query: 'track' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      // Should fall through to full validation, returning undefined via resolveDotPath
      expect(readSpy).toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_FastPath_FallsThrough_WhenCheckpointMissing', () => {
    it('should fall through to full validation when _checkpoint is missing from state', async () => {
      await handleInit({ featureId: 'fast-no-ckpt', workflowType: 'feature' }, tmpDir);

      // Manually corrupt the state file by removing _checkpoint
      const stateFile = path.join(tmpDir, 'fast-no-ckpt.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw._checkpoint;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-no-ckpt', query: 'phase' },
        tmpDir,
      );

      // Should fall through to full validation path
      expect(readSpy).toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_ComplexQuery_UsesFullValidation', () => {
    it('should use full validation for complex dot-path queries', async () => {
      await handleInit({ featureId: 'fast-complex', workflowType: 'feature' }, tmpDir);
      await handleSet(
        { featureId: 'fast-complex', updates: { 'tasks[0]': { id: 't1', title: 'Task 1', status: 'pending' } } },
        tmpDir,
      );

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-complex', query: 'tasks[0].status' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('pending');
      // Complex query should use full readStateFile validation
      expect(readSpy).toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  // ─── ToolSet ────────────────────────────────────────────────────────────────

  describe('ToolSet_FieldUpdates_AppliesAndReturns', () => {
    it('should apply field updates via dot-path', async () => {
      await handleInit({ featureId: 'set-test', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'set-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      // Verify the update was persisted
      const state = await readStateFile(path.join(tmpDir, 'set-test.state.json'));
      expect(state.artifacts.design).toBe('docs/design.md');
    });
  });

  describe('ToolSet_PhaseTransition_ValidatesViaHSM', () => {
    it('should validate phase transition via HSM and apply if valid', async () => {
      await handleInit({ featureId: 'phase-test', workflowType: 'feature' }, tmpDir);

      // First set the design artifact so the guard passes
      await handleSet(
        { featureId: 'phase-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      // Now transition from ideate -> plan
      const result = await handleSet(
        { featureId: 'phase-test', phase: 'plan' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      // Verify phase was updated on disk
      const state = await readStateFile(path.join(tmpDir, 'phase-test.state.json'));
      expect(state.phase).toBe('plan');
    });

    it('should apply updates before evaluating phase guards', async () => {
      await handleInit({ featureId: 'update-order', workflowType: 'feature' }, tmpDir);

      // Provide both updates AND phase in a single call — updates should be
      // applied first so the guard sees the new state
      const result = await handleSet(
        {
          featureId: 'update-order',
          updates: { 'artifacts.design': 'docs/design.md' },
          phase: 'plan',
        },
        tmpDir,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'update-order.state.json'));
      expect(state.phase).toBe('plan');
      expect(state.artifacts.design).toBe('docs/design.md');
    });

    it('should apply dynamic field updates before evaluating guards (planReview.approved)', async () => {
      await handleInit({ featureId: 'dynamic-guard', workflowType: 'feature' }, tmpDir);

      // Advance to plan-review
      await handleSet(
        { featureId: 'dynamic-guard', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'dynamic-guard', phase: 'plan' }, tmpDir);
      await handleSet(
        { featureId: 'dynamic-guard', updates: { 'artifacts.plan': 'plan.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'dynamic-guard', phase: 'plan-review' }, tmpDir);

      // Combined update + transition: set planReview.approved AND transition to delegate
      const result = await handleSet(
        {
          featureId: 'dynamic-guard',
          updates: { planReview: { approved: true } },
          phase: 'delegate',
        },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('delegate');

      // Verify on disk
      const state = await readStateFile(path.join(tmpDir, 'dynamic-guard.state.json'));
      expect(state.phase).toBe('delegate');
    });

    it('should return GUARD_FAILED for transition with unsatisfied guard', async () => {
      await handleInit({ featureId: 'guard-test', workflowType: 'feature' }, tmpDir);

      // Try to transition ideate -> plan without setting design artifact
      const result = await handleSet(
        { featureId: 'guard-test', phase: 'plan' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('GUARD_FAILED');
    });

    it('should return INVALID_TRANSITION for invalid target phase', async () => {
      await handleInit({ featureId: 'invalid-test', workflowType: 'feature' }, tmpDir);

      // Try to transition ideate -> synthesize (not a valid transition)
      const result = await handleSet(
        { featureId: 'invalid-test', phase: 'synthesize' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVALID_TRANSITION');
      expect(result.error?.validTargets).toBeDefined();
      expect(result.error?.validTargets).toContain('plan');
    });
  });

  describe('ToolSet_ReservedField_ReturnsReservedFieldError', () => {
    it('should reject updates to reserved fields (_prefix)', async () => {
      await handleInit({ featureId: 'reserved-test', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'reserved-test', updates: { '_events': [] } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject updates to nested reserved fields', async () => {
      await handleInit({ featureId: 'nested-reserved', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'nested-reserved', updates: { 'some._internal': 'value' } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject phase in updates — must use phase parameter instead', async () => {
      await handleInit({ featureId: 'phase-reserved', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'phase-reserved', updates: { phase: 'plan' } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESERVED_FIELD');
      expect(result.error?.message).toContain('phase');
    });

    it('should reject workflowType, featureId, createdAt, version in updates', async () => {
      await handleInit({ featureId: 'immutable-reserved', workflowType: 'feature' }, tmpDir);

      for (const field of ['workflowType', 'featureId', 'createdAt', 'version']) {
        const result = await handleSet(
          { featureId: 'immutable-reserved', updates: { [field]: 'hacked' } },
          tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('RESERVED_FIELD');
      }
    });
  });

  // ─── ToolCancel ──────────────────────────────────────────────────────────────

  describe('ToolCancel_ActiveWorkflow_ExecutesCompensationAndTransitions', () => {
    it('should cancel an active workflow, run compensation, and transition to cancelled', async () => {
      await handleInit({ featureId: 'cancel-active', workflowType: 'feature' }, tmpDir);

      const result = await handleCancel(
        { featureId: 'cancel-active' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
      expect(data.actions).toBeDefined();
      expect(Array.isArray(data.actions)).toBe(true);

      // Verify events include compensation and cancel events
      const state = await readStateFile(path.join(tmpDir, 'cancel-active.state.json'));
      expect(state.phase).toBe('cancelled');

      const events = state._events;
      const cancelEvents = events.filter((e) => e.type === 'cancel');
      expect(cancelEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ToolCancel_AlreadyCancelled_ReturnsAlreadyCancelled', () => {
    it('should return ALREADY_CANCELLED error when workflow is already cancelled', async () => {
      await handleInit({ featureId: 'cancel-twice', workflowType: 'feature' }, tmpDir);

      // Cancel it once
      await handleCancel({ featureId: 'cancel-twice' }, tmpDir);

      // Try to cancel again
      const result = await handleCancel({ featureId: 'cancel-twice' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ALREADY_CANCELLED');
    });
  });

  describe('ToolCancel_DryRun_ListsActionsNoExecution', () => {
    it('should return actions list without executing or changing state when dryRun is true', async () => {
      await handleInit({ featureId: 'cancel-dry', workflowType: 'feature' }, tmpDir);

      const result = await handleCancel(
        { featureId: 'cancel-dry', dryRun: true },
        tmpDir,
      );

      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data.actions).toBeDefined();
      expect(Array.isArray(data.actions)).toBe(true);
      expect(data.dryRun).toBe(true);

      // Verify state was NOT changed
      const state = await readStateFile(path.join(tmpDir, 'cancel-dry.state.json'));
      expect(state.phase).toBe('ideate');
    });
  });

  describe('ToolCancel_WithReason_IncludedInEvent', () => {
    it('should include the reason in the cancel event metadata', async () => {
      await handleInit({ featureId: 'cancel-reason', workflowType: 'feature' }, tmpDir);

      const result = await handleCancel(
        { featureId: 'cancel-reason', reason: 'Requirements changed' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'cancel-reason.state.json'));
      const cancelEvents = state._events.filter((e) => e.type === 'cancel');
      expect(cancelEvents.length).toBeGreaterThanOrEqual(1);

      const cancelEvent = cancelEvents[cancelEvents.length - 1];
      expect(cancelEvent.metadata).toBeDefined();
      expect(cancelEvent.metadata?.reason).toBe('Requirements changed');
    });
  });

  // ─── ToolCheckpoint ─────────────────────────────────────────────────────────

  describe('ToolCheckpoint_ExplicitTrigger_ResetsCounterAndLogsEvent', () => {
    it('should reset operation counter to 0 and log a checkpoint event', async () => {
      await handleInit({ featureId: 'ckpt-reset', workflowType: 'feature' }, tmpDir);

      // Do some set operations to increment the counter
      await handleSet(
        { featureId: 'ckpt-reset', updates: { 'artifacts.design': 'docs/d.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'ckpt-reset', updates: { 'artifacts.plan': 'docs/p.md' } },
        tmpDir,
      );

      // Now call checkpoint
      const result = await handleCheckpoint(
        { featureId: 'ckpt-reset' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      // After reset, _meta is slim (no action needed)
      expect(result._meta).toEqual({ checkpointAdvised: false });

      // Verify state on disk
      const state = await readStateFile(path.join(tmpDir, 'ckpt-reset.state.json'));
      expect(state._checkpoint.operationsSince).toBe(0);

      // Verify a checkpoint event was logged
      const checkpointEvents = state._events.filter(
        (e: { type: string }) => e.type === 'checkpoint',
      );
      expect(checkpointEvents.length).toBe(1);
    });
  });

  describe('ToolCheckpoint_WithSummary_IncludesInCheckpointState', () => {
    it('should include the summary in checkpoint state when provided', async () => {
      await handleInit({ featureId: 'ckpt-summary', workflowType: 'feature' }, tmpDir);

      const result = await handleCheckpoint(
        { featureId: 'ckpt-summary', summary: 'Completed initial design review' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      // Verify summary is persisted in checkpoint state
      const state = await readStateFile(path.join(tmpDir, 'ckpt-summary.state.json'));
      expect(state._checkpoint.summary).toBe('Completed initial design review');
    });
  });

  describe('ToolCheckpoint_Multiple_EachResetsCounter', () => {
    it('should reset the counter each time checkpoint is called', async () => {
      await handleInit({ featureId: 'ckpt-multi', workflowType: 'feature' }, tmpDir);

      // Do operations, checkpoint, do more operations, checkpoint again
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.design': 'docs/d1.md' } },
        tmpDir,
      );

      const result1 = await handleCheckpoint(
        { featureId: 'ckpt-multi' },
        tmpDir,
      );
      expect(result1.success).toBe(true);
      expect(result1._meta).toEqual({ checkpointAdvised: false });

      // Do more operations
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.plan': 'docs/p1.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.design': 'docs/d2.md' } },
        tmpDir,
      );

      const result2 = await handleCheckpoint(
        { featureId: 'ckpt-multi' },
        tmpDir,
      );
      expect(result2.success).toBe(true);
      expect(result2._meta).toEqual({ checkpointAdvised: false });

      // Verify two checkpoint events on disk
      const state = await readStateFile(path.join(tmpDir, 'ckpt-multi.state.json'));
      const checkpointEvents = state._events.filter(
        (e: { type: string }) => e.type === 'checkpoint',
      );
      expect(checkpointEvents.length).toBe(2);
    });
  });
});

// ─── Query Tools ─────────────────────────────────────────────────────────────

describe('Query Tools', () => {
  // ─── ToolSummary ──────────────────────────────────────────────────────────

  describe('ToolSummary_ActiveWorkflow_ReturnsStructuredSummary', () => {
    it('should return feature, phase, task progress, artifacts, recent events', async () => {
      // Create a workflow and add some data
      await handleInit({ featureId: 'summary-test', workflowType: 'feature' }, tmpDir);
      await handleSet(
        {
          featureId: 'summary-test',
          updates: {
            'artifacts.design': 'docs/design.md',
            'tasks[0]': { id: 'task-1', title: 'First task', status: 'complete' },
            'tasks[1]': { id: 'task-2', title: 'Second task', status: 'pending' },
          },
        },
        tmpDir,
      );

      const result = await handleSummary({ featureId: 'summary-test' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result._meta).toBeUndefined();

      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('summary-test');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('ideate');

      // Task progress
      const taskProgress = data.taskProgress as Record<string, number>;
      expect(taskProgress.completed).toBe(1);
      expect(taskProgress.total).toBe(2);

      // Artifacts
      const artifacts = data.artifacts as Record<string, unknown>;
      expect(artifacts.design).toBe('docs/design.md');

      // Recent events
      expect(data.recentEvents).toBeDefined();
      expect(Array.isArray(data.recentEvents)).toBe(true);
    });
  });

  describe('ToolSummary_IncludesRecentEventsAndCircuitBreaker', () => {
    it('should include last 5 events and circuit breaker state', async () => {
      await handleInit({ featureId: 'summary-cb', workflowType: 'feature' }, tmpDir);

      // Set design artifact and transition to plan to generate events
      await handleSet(
        { featureId: 'summary-cb', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'plan' }, tmpDir);

      // Set plan artifact and transition to plan-review, then delegate
      await handleSet(
        { featureId: 'summary-cb', updates: { 'artifacts.plan': 'plan.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'plan-review' }, tmpDir);
      await handleSet(
        { featureId: 'summary-cb', updates: { planReview: { approved: true } } },
        tmpDir,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'delegate' }, tmpDir);

      const result = await handleSummary({ featureId: 'summary-cb' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // Recent events should be present (last 5)
      const recentEvents = data.recentEvents as Array<unknown>;
      expect(recentEvents.length).toBeGreaterThan(0);
      expect(recentEvents.length).toBeLessThanOrEqual(5);

      // Circuit breaker state for the "implementation" compound
      const circuitBreaker = data.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.open).toBe(false);
      expect(circuitBreaker.fixCycleCount).toBe(0);
    });
  });

  describe('ToolSummary_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleSummary({ featureId: 'does-not-exist' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  // ─── ToolReconcile ────────────────────────────────────────────────────────

  describe('ToolReconcile_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleReconcile({ featureId: 'does-not-exist' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  describe('ToolReconcile_MatchingWorktrees_ReturnsAllOk', () => {
    it('should return OK status for worktrees that exist on disk', async () => {
      await handleInit({ featureId: 'reconcile-ok', workflowType: 'feature' }, tmpDir);

      // Create a real directory to act as a worktree path
      const worktreePath = path.join(tmpDir, 'worktree-1');
      await fs.mkdir(worktreePath, { recursive: true });

      // Write worktree with path directly into the state file to bypass Zod stripping
      const stateFile = path.join(tmpDir, 'reconcile-ok.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.worktrees.wt1 = {
        branch: 'feature/task-1',
        taskId: 'task-1',
        status: 'active',
        path: worktreePath,
      };
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleReconcile({ featureId: 'reconcile-ok' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const worktreeResults = data.worktrees as Array<Record<string, unknown>>;
      expect(worktreeResults).toBeDefined();
      expect(Array.isArray(worktreeResults)).toBe(true);

      // The worktree with a real path should have OK status
      const wt1 = worktreeResults.find((w) => w.id === 'wt1');
      expect(wt1).toBeDefined();
      expect(wt1?.pathStatus).toBe('OK');
    });
  });

  describe('ToolReconcile_MissingWorktree_ReportsMissing', () => {
    it('should detect and report missing worktrees', async () => {
      await handleInit({ featureId: 'reconcile-missing', workflowType: 'feature' }, tmpDir);

      // Write worktree with non-existent path directly into the state file
      const stateFile = path.join(tmpDir, 'reconcile-missing.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.worktrees.wt1 = {
        branch: 'feature/task-1',
        taskId: 'task-1',
        status: 'active',
        path: '/non/existent/worktree/path',
      };
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleReconcile({ featureId: 'reconcile-missing' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const worktreeResults = data.worktrees as Array<Record<string, unknown>>;
      expect(worktreeResults).toBeDefined();

      const wt1 = worktreeResults.find((w) => w.id === 'wt1');
      expect(wt1).toBeDefined();
      expect(wt1?.pathStatus).toBe('MISSING');
    });
  });

  // ─── ToolNextAction ───────────────────────────────────────────────────────

  describe('ToolNextAction_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleNextAction({ featureId: 'does-not-exist' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  describe('ToolNextAction_AutoContinue_ReturnsCorrectAction', () => {
    it('should return AUTO:plan when in ideate phase with design artifact', async () => {
      await handleInit({ featureId: 'next-auto', workflowType: 'feature' }, tmpDir);

      // Set the design artifact so the guard for ideate->plan passes
      await handleSet(
        { featureId: 'next-auto', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );

      const result = await handleNextAction({ featureId: 'next-auto' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('AUTO:plan');
    });
  });

  describe('ToolNextAction_HumanCheckpoint_ReturnsWait', () => {
    it('should return WAIT for synthesize phase (human checkpoint)', async () => {
      await handleInit({ featureId: 'next-wait', workflowType: 'feature' }, tmpDir);

      // Directly write the state at synthesize phase to avoid Zod field-stripping
      // issues with non-schema fields like 'integration'
      const stateFile = path.join(tmpDir, 'next-wait.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.phase = 'synthesize';
      raw._checkpoint.phase = 'synthesize';
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleNextAction({ featureId: 'next-wait' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toMatch(/^WAIT:human-checkpoint/);
    });
  });

  describe('ToolNextAction_CircuitOpen_ReturnsBlocked', () => {
    it('should return blocked when circuit breaker is open', async () => {
      await handleInit({ featureId: 'next-circuit', workflowType: 'feature' }, tmpDir);

      // Directly write state at review phase with 3 fix-cycle events and
      // a failed review. This bypasses the Zod field-stripping issue.
      const stateFile = path.join(tmpDir, 'next-circuit.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

      raw.phase = 'review';
      raw.reviews = { spec: { status: 'fail' } };
      raw.artifacts = { design: 'design.md', plan: 'plan.md', pr: null };
      raw._checkpoint.phase = 'review';

      // Add events: compound-entry followed by 3 fix-cycle events.
      // getFixCycleCount in events.ts uses metadata.compoundStateId to match.
      const baseSeq = raw._eventSequence || 0;
      const now = new Date().toISOString();
      raw._events = [
        {
          sequence: baseSeq + 1,
          version: '1.0',
          timestamp: now,
          type: 'compound-entry',
          trigger: 'execute-transition',
          from: 'plan',
          to: 'implementation',
          metadata: { compoundStateId: 'implementation' },
        },
        {
          sequence: baseSeq + 2,
          version: '1.0',
          timestamp: now,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          from: 'review',
          to: 'delegate',
          metadata: { compoundStateId: 'implementation' },
        },
        {
          sequence: baseSeq + 3,
          version: '1.0',
          timestamp: now,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          from: 'review',
          to: 'delegate',
          metadata: { compoundStateId: 'implementation' },
        },
        {
          sequence: baseSeq + 4,
          version: '1.0',
          timestamp: now,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          from: 'review',
          to: 'delegate',
          metadata: { compoundStateId: 'implementation' },
        },
      ];
      raw._eventSequence = baseSeq + 4;

      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleNextAction({ featureId: 'next-circuit' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toMatch(/^BLOCKED:circuit-open/);
    });
  });

  describe('ToolNextAction_FixCycleGuardPasses_ReturnsAutoFixes', () => {
    it('should return AUTO:delegate:--fixes when fix-cycle guard passes and circuit is not open', async () => {
      await handleInit({ featureId: 'next-fixcycle', workflowType: 'feature' }, tmpDir);

      // Write state at review phase with a failed review
      // and a compound-entry event (but NO fix-cycle events, so circuit stays closed)
      const stateFile = path.join(tmpDir, 'next-fixcycle.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

      raw.phase = 'review';
      raw.reviews = { spec: { status: 'fail' } };
      raw.artifacts = { design: 'design.md', plan: 'plan.md', pr: null };
      raw._checkpoint.phase = 'review';

      const now = new Date().toISOString();
      raw._events = [
        {
          sequence: 1,
          version: '1.0',
          timestamp: now,
          type: 'compound-entry',
          trigger: 'execute-transition',
          from: 'plan-review',
          to: 'implementation',
          metadata: { compoundStateId: 'implementation' },
        },
      ];
      raw._eventSequence = 1;

      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleNextAction({ featureId: 'next-fixcycle' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('AUTO:delegate:--fixes');
      expect(data.target).toBe('delegate');
    });
  });

  describe('ToolNextAction_NoGuardsPasses_ReturnsInProgress', () => {
    it('should return WAIT:in-progress when no outbound guard passes', async () => {
      await handleInit({ featureId: 'next-wait-prog', workflowType: 'feature' }, tmpDir);

      // Transition to plan phase (requires design artifact)
      await handleSet(
        { featureId: 'next-wait-prog', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'next-wait-prog', phase: 'plan' }, tmpDir);

      // Now at plan phase. The only outbound transition is plan → plan-review,
      // which requires artifacts.plan to exist. We don't set it, so guard fails.
      const result = await handleNextAction({ featureId: 'next-wait-prog' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('WAIT:in-progress:plan');
      expect(data.phase).toBe('plan');
    });
  });

  describe('ToolNextAction_CompletedPhase_ReturnsDone', () => {
    it('should return DONE for completed workflow', async () => {
      await handleInit({ featureId: 'next-done', workflowType: 'feature' }, tmpDir);

      // Write state directly at completed phase
      const stateFile = path.join(tmpDir, 'next-done.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.phase = 'completed';
      raw._checkpoint.phase = 'completed';
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleNextAction({ featureId: 'next-done' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('DONE');
      expect(data.phase).toBe('completed');
    });
  });

  // ─── ToolTransitions ──────────────────────────────────────────────────────

  describe('ToolTransitions_FeatureWorkflow_ReturnsFullGraph', () => {
    it('should return all states and transitions for a workflow type', async () => {
      const result = await handleTransitions(
        { workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // Should include states
      const states = data.states as Array<Record<string, unknown>>;
      expect(states).toBeDefined();
      expect(states.length).toBeGreaterThan(0);

      // Should include ideate, plan, delegate, review, synthesize, completed
      const stateIds = states.map((s) => s.id);
      expect(stateIds).toContain('ideate');
      expect(stateIds).toContain('plan');
      expect(stateIds).toContain('delegate');
      expect(stateIds).toContain('synthesize');
      expect(stateIds).toContain('completed');

      // Should include transitions
      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();
      expect(transitions.length).toBeGreaterThan(0);

      // Each transition should have guard description
      const ideateToPlan = transitions.find(
        (t) => t.from === 'ideate' && t.to === 'plan',
      );
      expect(ideateToPlan).toBeDefined();
      expect(ideateToPlan?.guardDescription).toBeDefined();
    });
  });

  describe('ToolTransitions_FromSpecificPhase_ReturnsFilteredTransitions', () => {
    it('should return only outbound transitions from specified phase', async () => {
      const result = await handleTransitions(
        { workflowType: 'feature', fromPhase: 'delegate' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();

      // delegate has one transition: to review (all tasks complete)
      expect(transitions.length).toBeGreaterThanOrEqual(1);

      // All transitions should be from 'delegate'
      for (const t of transitions) {
        expect(t.from).toBe('delegate');
      }

      const toReview = transitions.find((t) => t.to === 'review');
      expect(toReview).toBeDefined();
    });
  });
});

// ─── Integration Tests for Bug Fixes ────────────────────────────────────────

describe('ToolSet_DynamicFields_SurviveRoundTrip', () => {
  it('should preserve dynamic fields through set and get', async () => {
    await handleInit({ featureId: 'dynamic-test', workflowType: 'refactor' }, tmpDir);

    // Set dynamic fields
    await handleSet(
      {
        featureId: 'dynamic-test',
        updates: {
          track: 'polish',
          'explore.scopeAssessment': { filesAffected: 5, recommendedTrack: 'polish' },
        },
      },
      tmpDir,
    );

    // Read back via handleGet (no query — full state)
    const getResult = await handleGet({ featureId: 'dynamic-test' }, tmpDir);
    expect(getResult.success).toBe(true);
    const data = getResult.data as Record<string, unknown>;
    expect(data.track).toBe('polish');
    expect(data.explore).toBeDefined();
    const explore = data.explore as Record<string, unknown>;
    expect(explore.scopeAssessment).toEqual({ filesAffected: 5, recommendedTrack: 'polish' });
  });

  it('should query dynamic fields via dot-path', async () => {
    await handleInit({ featureId: 'query-dynamic', workflowType: 'feature' }, tmpDir);

    await handleSet(
      {
        featureId: 'query-dynamic',
        updates: { planReview: { approved: true, gapsFound: false } },
      },
      tmpDir,
    );

    // Query specific dynamic field
    const result = await handleGet(
      { featureId: 'query-dynamic', query: 'planReview.approved' },
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe(true);
  });
});

describe('ToolSet_RefactorTransition_ExploreToBrief', () => {
  it('should transition from explore to brief when scope assessment is set', async () => {
    await handleInit({ featureId: 'refactor-transition', workflowType: 'refactor' }, tmpDir);

    // Set the scope assessment (required by guard)
    await handleSet(
      {
        featureId: 'refactor-transition',
        updates: {
          explore: {
            scopeAssessment: { filesAffected: 3, recommendedTrack: 'polish' },
          },
        },
      },
      tmpDir,
    );

    // Now transition from explore → brief (guard checks explore.scopeAssessment)
    const result = await handleSet(
      { featureId: 'refactor-transition', phase: 'brief' },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('brief');
  });

  it('should transition from explore to brief in a single combined call', async () => {
    await handleInit({ featureId: 'refactor-combined', workflowType: 'refactor' }, tmpDir);

    // Set scope assessment AND transition in one call — guard should see updated state
    const result = await handleSet(
      {
        featureId: 'refactor-combined',
        updates: {
          track: 'polish',
          'explore.startedAt': '2026-02-08T00:00:00.000Z',
          'explore.completedAt': '2026-02-08T00:05:00.000Z',
          'explore.scopeAssessment': { filesAffected: ['a.ts'], recommendedTrack: 'polish' },
        },
        phase: 'brief',
      },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('brief');

    // Verify on disk
    const state = await readStateFile(path.join(tmpDir, 'refactor-combined.state.json'));
    expect(state.phase).toBe('brief');
  });
});

describe('ToolSet_DeepCopy_OriginalStateUnaffected (Bug 8)', () => {
  it('should not mutate the original state read from disk when applying updates', async () => {
    await handleInit({ featureId: 'deep-copy', workflowType: 'feature' }, tmpDir);

    // Set a nested field
    const result = await handleSet(
      {
        featureId: 'deep-copy',
        updates: { 'artifacts.design': 'docs/design.md' },
      },
      tmpDir,
    );

    expect(result.success).toBe(true);

    // Read the state back from disk to verify it was written correctly
    const state = await readStateFile(path.join(tmpDir, 'deep-copy.state.json'));
    expect(state.artifacts.design).toBe('docs/design.md');
    // The original state's siblings should be intact
    expect(state.artifacts.plan).toBeNull();
    expect(state.artifacts.pr).toBeNull();
  });
});

describe('ToolSet_ArtifactUpdate_PreservesSiblings', () => {
  it('should preserve plan and pr when setting design via object update', async () => {
    await handleInit({ featureId: 'artifact-merge', workflowType: 'feature' }, tmpDir);

    // Update artifacts using object (not dot-path)
    const result = await handleSet(
      {
        featureId: 'artifact-merge',
        updates: { artifacts: { design: 'docs/design.md' } },
      },
      tmpDir,
    );

    expect(result.success).toBe(true);

    // Verify via disk read (handleSet returns slim response, not full state)
    const state = await readStateFile(path.join(tmpDir, 'artifact-merge.state.json'));
    expect(state.artifacts.design).toBe('docs/design.md');
    expect(state.artifacts.plan).toBeNull();
    expect(state.artifacts.pr).toBeNull();
  });
});

// ─── Slim Response Tests ──────────────────────────────────────────────────────

describe('ToolSet_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only phase and updatedAt, not full state', async () => {
    await handleInit({ featureId: 'slim-set', workflowType: 'feature' }, tmpDir);

    const result = await handleSet(
      { featureId: 'slim-set', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Slim response should include phase and updatedAt
    expect(data.phase).toBe('ideate');
    expect(data.updatedAt).toBeDefined();
    expect(typeof data.updatedAt).toBe('string');

    // Should NOT include full state fields
    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data._checkpoint).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
  });

  it('should return updated phase after transition', async () => {
    await handleInit({ featureId: 'slim-transition', workflowType: 'feature' }, tmpDir);

    const result = await handleSet(
      {
        featureId: 'slim-transition',
        updates: { 'artifacts.design': 'docs/design.md' },
        phase: 'plan',
      },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
  });
});

describe('ToolInit_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only featureId, workflowType, and phase, not full state', async () => {
    const result = await handleInit(
      { featureId: 'slim-init', workflowType: 'feature' },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Slim response should include identity fields
    expect(data.featureId).toBe('slim-init');
    expect(data.workflowType).toBe('feature');
    expect(data.phase).toBe('ideate');

    // Should NOT include full state fields
    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data._checkpoint).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
  });
});

describe('ToolCheckpoint_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only phase, not full state', async () => {
    await handleInit({ featureId: 'slim-ckpt', workflowType: 'feature' }, tmpDir);

    const result = await handleCheckpoint(
      { featureId: 'slim-ckpt', summary: 'Test checkpoint' },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Slim response should include phase
    expect(data.phase).toBe('ideate');

    // Should NOT include full state fields
    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
  });
});

// ─── Refactor Next-Action Tests ──────────────────────────────────────────────

describe('ToolNextAction_Refactor_ReturnsCorrectActions', () => {
  it('explore_GuardPasses_ReturnsAutoRefactorBrief', async () => {
    await handleInit({ featureId: 'refactor-na-explore', workflowType: 'refactor' }, tmpDir);

    // Set explore.scopeAssessment so the explore->brief guard passes
    await handleSet(
      {
        featureId: 'refactor-na-explore',
        updates: {
          'explore.scopeAssessment': {
            filesAffected: ['a.ts'],
            modulesAffected: ['mod'],
            testCoverage: 'good',
            recommendedTrack: 'polish',
          },
          'explore.completedAt': new Date().toISOString(),
        },
      },
      tmpDir,
    );

    const result = await handleNextAction({ featureId: 'refactor-na-explore' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-brief');
  });

  it('brief_PolishGuardPasses_ReturnsAutoPolishImplement', async () => {
    await handleInit({ featureId: 'refactor-na-brief-polish', workflowType: 'refactor' }, tmpDir);

    // Transition explore -> brief
    await handleSet(
      {
        featureId: 'refactor-na-brief-polish',
        updates: {
          'explore.scopeAssessment': {
            filesAffected: ['a.ts'],
            modulesAffected: ['mod'],
            testCoverage: 'good',
            recommendedTrack: 'polish',
          },
        },
      },
      tmpDir,
    );
    await handleSet(
      { featureId: 'refactor-na-brief-polish', phase: 'brief' },
      tmpDir,
    );

    // Set track and brief data so polishTrackSelected guard passes
    await handleSet(
      {
        featureId: 'refactor-na-brief-polish',
        updates: {
          track: 'polish',
          brief: {
            problem: 'test',
            goals: ['g1'],
            approach: 'a',
            affectedAreas: ['a.ts'],
            outOfScope: [],
            successCriteria: ['s1'],
            docsToUpdate: [],
          },
        },
      },
      tmpDir,
    );

    const result = await handleNextAction({ featureId: 'refactor-na-brief-polish' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // Fallback produces AUTO:polish-implement (transition.to)
    expect(data.action).toBe('AUTO:polish-implement');
  });

  it('brief_OverhaulGuardPasses_ReturnsAutoOverhaulPlan', async () => {
    await handleInit({ featureId: 'refactor-na-brief-overhaul', workflowType: 'refactor' }, tmpDir);

    // Transition explore -> brief
    await handleSet(
      {
        featureId: 'refactor-na-brief-overhaul',
        updates: {
          'explore.scopeAssessment': {
            filesAffected: ['a.ts'],
            modulesAffected: ['mod'],
            testCoverage: 'good',
            recommendedTrack: 'overhaul',
          },
        },
      },
      tmpDir,
    );
    await handleSet(
      { featureId: 'refactor-na-brief-overhaul', phase: 'brief' },
      tmpDir,
    );

    // Set track to overhaul so overhaulTrackSelected guard passes
    await handleSet(
      {
        featureId: 'refactor-na-brief-overhaul',
        updates: {
          track: 'overhaul',
          brief: {
            problem: 'test',
            goals: ['g1'],
            approach: 'a',
            affectedAreas: ['a.ts'],
            outOfScope: [],
            successCriteria: ['s1'],
            docsToUpdate: [],
          },
        },
      },
      tmpDir,
    );

    const result = await handleNextAction({ featureId: 'refactor-na-brief-overhaul' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // Fallback produces AUTO:overhaul-plan (transition.to)
    expect(data.action).toBe('AUTO:overhaul-plan');
  });

  it('polishImplement_GuardPasses_ReturnsAutoRefactorValidate', async () => {
    await handleInit({ featureId: 'refactor-na-polish-impl', workflowType: 'refactor' }, tmpDir);

    // Advance to polish-implement via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-polish-impl.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'polish-implement';
    raw.track = 'polish';
    raw._checkpoint.phase = 'polish-implement';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    // implementationComplete guard always returns true, so next_action should proceed
    const result = await handleNextAction({ featureId: 'refactor-na-polish-impl' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-validate');
  });

  it('polishUpdateDocs_HumanCheckpoint_ReturnsWait', async () => {
    await handleInit({ featureId: 'refactor-na-polish-docs', workflowType: 'refactor' }, tmpDir);

    // Advance to polish-update-docs via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-polish-docs.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'polish-update-docs';
    raw.track = 'polish';
    raw._checkpoint.phase = 'polish-update-docs';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-polish-docs' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('WAIT:human-checkpoint:polish-update-docs');
  });

  it('overhaulPlan_GuardPasses_ReturnsAutoRefactorDelegate', async () => {
    await handleInit({ featureId: 'refactor-na-overhaul-plan', workflowType: 'refactor' }, tmpDir);

    // Advance to overhaul-plan via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-overhaul-plan.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-plan';
    raw.track = 'overhaul';
    raw.artifacts = { design: null, plan: 'plan.md', pr: null };
    raw._checkpoint.phase = 'overhaul-plan';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-overhaul-plan' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-delegate');
  });

  it('overhaulUpdateDocs_GuardPasses_ReturnsAutoRefactorSynthesize', async () => {
    await handleInit({ featureId: 'refactor-na-overhaul-docs', workflowType: 'refactor' }, tmpDir);

    // Advance to overhaul-update-docs via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-overhaul-docs.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-update-docs';
    raw.track = 'overhaul';
    raw.validation = { docsUpdated: true };
    raw._checkpoint.phase = 'overhaul-update-docs';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-overhaul-docs' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-synthesize');
  });

  it('polishValidate_GuardPasses_ReturnsAutoRefactorUpdateDocs', async () => {
    await handleInit({ featureId: 'refactor-na-polish-val', workflowType: 'refactor' }, tmpDir);

    // Advance to polish-validate via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-polish-val.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'polish-validate';
    raw.track = 'polish';
    raw.validation = { testsPass: true };
    raw._checkpoint.phase = 'polish-validate';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-polish-val' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-update-docs');
  });

  it('overhaulDelegate_GuardPasses_ReturnsAutoRefactorReview', async () => {
    await handleInit({ featureId: 'refactor-na-oh-del', workflowType: 'refactor' }, tmpDir);

    const stateFile = path.join(tmpDir, 'refactor-na-oh-del.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-delegate';
    raw.track = 'overhaul';
    raw.tasks = [{ id: '1', title: 'Task 1', status: 'complete' }];
    raw._checkpoint.phase = 'overhaul-delegate';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-oh-del' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-review');
  });

  it('overhaulReview_GuardPasses_ReturnsAutoRefactorUpdateDocs', async () => {
    await handleInit({ featureId: 'refactor-na-oh-rev', workflowType: 'refactor' }, tmpDir);

    const stateFile = path.join(tmpDir, 'refactor-na-oh-rev.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-review';
    raw.track = 'overhaul';
    raw.reviews = { spec: { status: 'approved' } };
    raw._checkpoint.phase = 'overhaul-review';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-oh-rev' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-update-docs');
  });

  it('synthesize_HumanCheckpoint_ReturnsWait', async () => {
    await handleInit({ featureId: 'refactor-na-synth', workflowType: 'refactor' }, tmpDir);

    // Advance to synthesize via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-synth.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'synthesize';
    raw._checkpoint.phase = 'synthesize';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-synth' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('WAIT:human-checkpoint:synthesize');
  });
});

// ─── B4: Bridge Workflow Transitions to External Event Store ───────────────

describe('External Event Store Bridge', () => {
  it('handleSet_PhaseTransition_AppendsToExternalStore: after transition, JSONL file has event', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Create a feature workflow at ideate
    await handleInit({ featureId: 'bridge-test', workflowType: 'feature' }, tmpDir);

    // Set design artifact to satisfy ideate->plan guard
    await handleSet(
      { featureId: 'bridge-test', updates: { 'artifacts.design': 'docs/test.md' } },
      tmpDir,
    );

    // Transition from ideate to plan
    const result = await handleSet(
      { featureId: 'bridge-test', phase: 'plan' },
      tmpDir,
    );
    expect(result.success).toBe(true);

    // Query external event store for workflow.transition events
    const events = await eventStore.query('bridge-test', { type: 'workflow.transition' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Verify the transition event data
    const transitionEvent = events.find(e =>
      (e.data as Record<string, unknown>)?.to === 'plan'
    );
    expect(transitionEvent).toBeDefined();
    expect((transitionEvent!.data as Record<string, unknown>)?.featureId).toBe('bridge-test');
  });

  it('handleCheckpoint_AppendsToExternalStore: after checkpoint, JSONL file has event', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'cp-bridge', workflowType: 'feature' }, tmpDir);

    const result = await handleCheckpoint(
      { featureId: 'cp-bridge', summary: 'test checkpoint' },
      tmpDir,
    );
    expect(result.success).toBe(true);

    // Query external event store for workflow.checkpoint events
    const events = await eventStore.query('cp-bridge', { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    expect((events[0].data as Record<string, unknown>)?.phase).toBe('ideate');
    expect((events[0].data as Record<string, unknown>)?.featureId).toBe('cp-bridge');
  });
});

describe('Store-Based Event Consumers', () => {
  it('getFixCycleCountFromStore_ReturnsCorrectCount', async () => {
    const { getFixCycleCountFromStore } = await import('../../workflow/events.js');
    const eventStore = new EventStore(tmpDir);

    // Append a compound-entry event
    await eventStore.append('fix-test', {
      type: 'workflow.compound-entry',
      data: { compoundStateId: 'feature-delegate-review', featureId: 'fix-test' },
    });

    // Append fix-cycle events
    await eventStore.append('fix-test', {
      type: 'workflow.fix-cycle',
      data: { compoundStateId: 'feature-delegate-review', count: 1, featureId: 'fix-test' },
    });
    await eventStore.append('fix-test', {
      type: 'workflow.fix-cycle',
      data: { compoundStateId: 'feature-delegate-review', count: 2, featureId: 'fix-test' },
    });

    const count = await getFixCycleCountFromStore(
      eventStore,
      'fix-test',
      'feature-delegate-review',
    );
    expect(count).toBe(2);
  });

  it('getRecentEventsFromStore_ReturnsLastN', async () => {
    const { getRecentEventsFromStore } = await import('../../workflow/events.js');
    const eventStore = new EventStore(tmpDir);

    await eventStore.append('recent-test', { type: 'workflow.started' });
    await eventStore.append('recent-test', { type: 'team.formed' });
    await eventStore.append('recent-test', { type: 'phase.transitioned' });
    await eventStore.append('recent-test', { type: 'task.assigned' });
    await eventStore.append('recent-test', { type: 'task.completed' });

    const recent = await getRecentEventsFromStore(eventStore, 'recent-test', 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].type).toBe('phase.transitioned');
    expect(recent[2].type).toBe('task.completed');
  });
});
