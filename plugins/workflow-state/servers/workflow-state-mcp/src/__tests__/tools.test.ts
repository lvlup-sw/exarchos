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
} from '../tools.js';
import { initStateFile, readStateFile, writeStateFile } from '../state-store.js';
import * as stateStore from '../state-store.js';
import type { WorkflowState } from '../types.js';

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

      // Directly write state at integrate phase with 3 fix-cycle events and
      // integration.passed = false. This bypasses the Zod field-stripping issue
      // where non-schema fields like 'integration' are lost on readback.
      const stateFile = path.join(tmpDir, 'next-circuit.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

      raw.phase = 'integrate';
      raw.integration = { passed: false };
      raw.artifacts = { design: 'design.md', plan: 'plan.md', pr: null };
      raw._checkpoint.phase = 'integrate';

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
          from: 'integrate',
          to: 'delegate',
          metadata: { compoundStateId: 'implementation' },
        },
        {
          sequence: baseSeq + 3,
          version: '1.0',
          timestamp: now,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          from: 'integrate',
          to: 'delegate',
          metadata: { compoundStateId: 'implementation' },
        },
        {
          sequence: baseSeq + 4,
          version: '1.0',
          timestamp: now,
          type: 'fix-cycle',
          trigger: 'execute-transition',
          from: 'integrate',
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

      // Write state at integrate phase with integration.passed = false
      // and a compound-entry event (but NO fix-cycle events, so circuit stays closed)
      const stateFile = path.join(tmpDir, 'next-fixcycle.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

      raw.phase = 'integrate';
      raw.integration = { passed: false };
      raw.artifacts = { design: 'design.md', plan: 'plan.md', pr: null };
      raw._checkpoint.phase = 'integrate';

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

      // Should include ideate, plan, delegate, integrate, review, synthesize, completed
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
        { workflowType: 'feature', fromPhase: 'integrate' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();

      // integrate has transitions to: review (passed) and delegate (failed)
      expect(transitions.length).toBeGreaterThanOrEqual(2);

      // All transitions should be from 'integrate'
      for (const t of transitions) {
        expect(t.from).toBe('integrate');
      }

      const toReview = transitions.find((t) => t.to === 'review');
      expect(toReview).toBeDefined();

      const toDelegate = transitions.find((t) => t.to === 'delegate');
      expect(toDelegate).toBeDefined();
      expect(toDelegate?.isFixCycle).toBe(true);
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

// ─── Cancel Rollback Tests ──────────────────────────────────────────────────

describe('ToolCancel_ValidationFailure_RollsBackToPreviousState', () => {
  it('should rollback to pre-cancel state when writeStateFile throws STATE_CORRUPT', async () => {
    // Arrange: create workflow and advance to plan phase
    await handleInit({ featureId: 'cancel-rb', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'cancel-rb', updates: { 'artifacts.design': 'docs/d.md' }, phase: 'plan' },
      tmpDir,
    );

    // Read state before cancel attempt
    const stateBefore = await readStateFile(path.join(tmpDir, 'cancel-rb.state.json'));
    expect(stateBefore.phase).toBe('plan');

    // Mock writeStateFile to throw STATE_CORRUPT on the next call
    const writeSpy = vi.spyOn(stateStore, 'writeStateFile').mockRejectedValueOnce(
      new Error('STATE_CORRUPT: Write-time validation failed: phase: Invalid'),
    );

    // Act
    const result = await handleCancel({ featureId: 'cancel-rb' }, tmpDir);

    // Assert: operation reports failure with rollback info
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_CORRUPT');
    expect(result.error?.message).toContain('rolled back');

    // Verify state on disk is restored to pre-cancel state
    const stateAfter = await readStateFile(path.join(tmpDir, 'cancel-rb.state.json'));
    expect(stateAfter.phase).toBe('plan'); // Not cancelled

    writeSpy.mockRestore();
  });

  it('should re-throw non-STATE_CORRUPT errors without rollback', async () => {
    // Arrange: create workflow
    await handleInit({ featureId: 'cancel-rethrow', workflowType: 'feature' }, tmpDir);

    // Mock writeStateFile to throw a generic error
    const writeSpy = vi.spyOn(stateStore, 'writeStateFile').mockRejectedValueOnce(
      new Error('FILE_IO_ERROR: Disk full'),
    );

    // Act & Assert: non-STATE_CORRUPT errors should be re-thrown
    await expect(
      handleCancel({ featureId: 'cancel-rethrow' }, tmpDir),
    ).rejects.toThrow('FILE_IO_ERROR: Disk full');

    writeSpy.mockRestore();
  });
});

// ─── Checkpoint Rollback Tests ──────────────────────────────────────────────

describe('handleCheckpoint_ValidationFailure_RollsBackToPreviousState', () => {
  it('should rollback on validation failure during checkpoint', async () => {
    // Arrange
    await handleInit({ featureId: 'cp-rb', workflowType: 'feature' }, tmpDir);

    // Read state before checkpoint
    const stateBefore = await readStateFile(path.join(tmpDir, 'cp-rb.state.json'));

    // Mock writeStateFile to throw STATE_CORRUPT on next call
    const writeSpy = vi.spyOn(stateStore, 'writeStateFile').mockRejectedValueOnce(
      new Error('STATE_CORRUPT: Write-time validation failed: _checkpoint: Invalid'),
    );

    // Act
    const result = await handleCheckpoint({ featureId: 'cp-rb', summary: 'test checkpoint' }, tmpDir);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_CORRUPT');
    expect(result.error?.message).toContain('rolled back');

    // Verify state on disk is restored (phase unchanged)
    const stateAfter = await readStateFile(path.join(tmpDir, 'cp-rb.state.json'));
    expect(stateAfter.phase).toBe(stateBefore.phase);
    expect(stateAfter._eventSequence).toBe(stateBefore._eventSequence);

    writeSpy.mockRestore();
  });
});

// ─── Set Rollback Tests ─────────────────────────────────────────────────────

describe('ToolSet_SnapshotRollback', () => {
  describe('handleSet_InvalidMutationProducesCorruptState_RollsBackToPreviousState', () => {
    it('should roll back to previous state when mutation produces invalid state', async () => {
      // Init a feature workflow
      await handleInit({ featureId: 'set-rollback', workflowType: 'feature' }, tmpDir);

      // Do a valid update first
      const validResult = await handleSet(
        { featureId: 'set-rollback', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );
      expect(validResult.success).toBe(true);

      // Read the state before corruption attempt to know expected state
      const stateBefore = await readStateFile(path.join(tmpDir, 'set-rollback.state.json'));
      expect(stateBefore.artifacts.design).toBe('docs/design.md');
      expect(Array.isArray(stateBefore.tasks)).toBe(true);

      // Attempt an update that corrupts state: set `tasks` to a string value
      // This will pass applyDotPath but fail schema validation at writeStateFile
      const corruptResult = await handleSet(
        { featureId: 'set-rollback', updates: { tasks: 'not-an-array' } },
        tmpDir,
      );

      // Should return failure with STATE_CORRUPT code
      expect(corruptResult.success).toBe(false);
      expect(corruptResult.error).toBeDefined();
      expect(corruptResult.error?.code).toBe('STATE_CORRUPT');

      // Read state from disk and verify it matches the pre-corruption state
      const stateAfter = await readStateFile(path.join(tmpDir, 'set-rollback.state.json'));
      expect(stateAfter.artifacts.design).toBe('docs/design.md');
      expect(Array.isArray(stateAfter.tasks)).toBe(true);
      expect(stateAfter.tasks).toEqual(stateBefore.tasks);
    });
  });

  describe('handleSet_InvalidMutation_ErrorIncludesValidationDetails', () => {
    it('should include "rolled back" in the error message', async () => {
      await handleInit({ featureId: 'set-rb-msg', workflowType: 'feature' }, tmpDir);

      // Do a valid update first
      await handleSet(
        { featureId: 'set-rb-msg', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      // Attempt a corrupting update
      const corruptResult = await handleSet(
        { featureId: 'set-rb-msg', updates: { tasks: 'not-an-array' } },
        tmpDir,
      );

      expect(corruptResult.success).toBe(false);
      expect(corruptResult.error?.code).toBe('STATE_CORRUPT');
      expect(corruptResult.error?.message).toContain('rolled back');
    });
  });

  describe('handleSet_FileIOError_RethrowsWithoutSwallowing', () => {
    it('should re-throw non-STATE_CORRUPT errors without catching them', async () => {
      await handleInit({ featureId: 'set-rethrow', workflowType: 'feature' }, tmpDir);

      // Do a valid update first to ensure state is in a good place
      await handleSet(
        { featureId: 'set-rethrow', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      // Make the directory read-only to cause a write failure (not STATE_CORRUPT)
      await fs.chmod(tmpDir, 0o444);

      try {
        // This should throw a FILE_IO_ERROR, not return { success: false }
        await expect(
          handleSet(
            { featureId: 'set-rethrow', updates: { 'artifacts.plan': 'docs/plan.md' } },
            tmpDir,
          ),
        ).rejects.toThrow();
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(tmpDir, 0o755);
      }
    });
  });
});
