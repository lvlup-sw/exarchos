// The checkpoint path of `executeCompensation`. The `child_process` mock fails and counts each process start,
// because the ledger-only compensation must start none.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '../../../src/workflow/types.js';
import type { CompensationCheckpoint } from '../../../src/workflow/compensation.js';
import { executeCompensation } from '../../../src/workflow/compensation.js';

const processStarts = vi.hoisted(() => ({ count: 0 }));

vi.mock('child_process', () => {
  const refuse = (): never => {
    processStarts.count += 1;
    throw new Error('the ledger-only cancel started a process');
  };
  return {
    exec: vi.fn(refuse),
    execFile: vi.fn(refuse),
    execFileSync: vi.fn(refuse),
    execSync: vi.fn(refuse),
    spawn: vi.fn(refuse),
    spawnSync: vi.fn(refuse),
  };
});

/** Builds a minimal feature workflow state in the delegate phase, with the given overrides. */
function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'delegate',
    synthesis: {
      integrationBranch: 'integrate/test-feature',
      mergeOrder: [],
      mergedBranches: [],
      prUrl: 'https://github.com/org/repo/pull/42',
      prFeedback: [],
    },
    worktrees: {
      'task-1': { branch: 'feature/test-feature/task-1', taskId: 'task-1', status: 'active' },
      'task-2': { branch: 'feature/test-feature/task-2', taskId: 'task-2', status: 'active' },
    },
    tasks: [
      { id: 'task-1', title: 'Task 1', status: 'complete', branch: 'feature/test-feature/task-1' },
      { id: 'task-2', title: 'Task 2', status: 'complete', branch: 'feature/test-feature/task-2' },
    ],
    ...overrides,
  };
}

function makeEvents(count: number): Event[] {
  const events: Event[] = [];
  for (let i = 1; i <= count; i++) {
    events.push({
      sequence: i,
      version: '1.0',
      timestamp: new Date().toISOString(),
      type: 'transition',
      trigger: `trigger-${i}`,
    });
  }
  return events;
}

/** A synthesis with no PR and no integration branch. */
const EMPTY_SYNTHESIS = {
  integrationBranch: null,
  mergeOrder: [],
  mergedBranches: [],
  prUrl: null,
  prFeedback: [],
};

describe('Compensation', () => {
  /** Each case starts with no recorded process start. */
  beforeEach(() => {
    processStarts.count = 0;
  });

  describe('ExecuteCompensation_AllPhases_RunsReverseOrder', () => {
    it('should run compensation actions in reverse phase order from current phase', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(3);

      const result = await executeCompensation(state, 'synthesize', events, 3, { dryRun: false });

      const actionIds = result.actions.map((a) => a.actionId);

      const synthesizeIdx = actionIds.findIndex((id) => id.startsWith('synthesize:'));
      const delegateIdx = actionIds.findIndex((id) => id.startsWith('delegate:'));

      expect(synthesizeIdx).toBeGreaterThanOrEqual(0);
      expect(delegateIdx).toBeGreaterThanOrEqual(0);

      expect(synthesizeIdx).toBeLessThan(delegateIdx);
    });
  });

  describe('ExecuteCompensation_AlreadyCleaned_SkipsWithNoOp', () => {
    it('should skip actions with no-op when resources do not exist', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      expect(result.actions.length).toBeGreaterThan(0);

      for (const action of result.actions) {
        expect(action.status).toBe('skipped');
      }

      expect(processStarts.count).toBe(0);

      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteCompensation_DryRun_ListsActionsNoExecution', () => {
    it('should list what would happen in dry-run mode without executing', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: true });

      const listed = result.actions.filter((a) => a.status !== 'skipped');
      expect(listed.length).toBeGreaterThan(0);
      for (const action of listed) {
        expect(action.status).toBe('dry-run');
      }

      expect(processStarts.count).toBe(0);

      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteCompensation_LedgerOnly_StartsNoProcess', () => {
    /** A shell-shaped branch name is data. The cancel records it literally and starts no process. */
    it('should record a shell-shaped branch name literally and start no process', async () => {
      const shellShapedBranch = '$(rm -rf /)';
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {},
        tasks: [{ id: 'task-1', title: 'Task 1', status: 'complete', branch: shellShapedBranch }],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      expect(processStarts.count).toBe(0);
      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction?.status).toBe('outstanding');
      expect(deleteAction?.resources).toEqual([
        { kind: 'feature-branch', ref: shellShapedBranch, status: 'outstanding' },
      ]);
    });
  });

  /** For a phase outside `PHASE_ORDER`, `getPhasesInReverseOrder` returns every phase in reverse order. */
  describe('ExecuteCompensation_UnknownPhase_RunsAllActions', () => {
    it('should run all compensation actions when phase is not in PHASE_ORDER', async () => {
      const state = makeState({ phase: 'unknown-phase' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'unknown-phase', events, 1, { dryRun: true });

      expect(result.actions.length).toBeGreaterThan(0);

      for (const action of result.actions) {
        expect(['dry-run', 'skipped']).toContain(action.status);
      }

      const actionIds = result.actions.map((a) => a.actionId);
      const hasSynthesize = actionIds.some((id) => id.startsWith('synthesize:'));
      const hasDelegate = actionIds.some((id) => id.startsWith('delegate:'));

      expect(hasSynthesize).toBe(true);
      expect(hasDelegate).toBe(true);

      const synthesizeIdx = actionIds.findIndex((id) => id.startsWith('synthesize:'));
      const delegateIdx = actionIds.findIndex((id) => id.startsWith('delegate:'));

      expect(synthesizeIdx).toBeLessThan(delegateIdx);

      expect(result.success).toBe(true);
    });

    it('should run all compensation actions with execution when phase is unknown', async () => {
      const state = makeState({ phase: 'unknown-phase' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'unknown-phase', events, 1, { dryRun: false });

      expect(result.actions.length).toBeGreaterThan(0);

      const actionIds = result.actions.map((a) => a.actionId);
      expect(actionIds.some((id) => id.startsWith('synthesize:'))).toBe(true);
      expect(actionIds.some((id) => id.startsWith('delegate:'))).toBe(true);
    });
  });

  describe('ExecuteCompensation_IdeatePhase_OnlyEarlyActions', () => {
    /** `plan` is the first phase in `PHASE_ORDER`, and it registers no compensation action. */
    it('should only include actions up to ideate phase (no actions since ideate has none)', async () => {
      const state = makeState({
        phase: 'ideate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'plan', events, 1, { dryRun: false });

      expect(result.actions.length).toBe(0);
      expect(result.events.length).toBe(0);
      expect(result.success).toBe(true);
    });
  });

  describe('ClosePrAction_NullPrUrl_ReturnsSkipped', () => {
    it('should return skipped when prUrl is null but synthesis object exists', async () => {
      const state = makeState({
        phase: 'synthesize',
        synthesis: { ...EMPTY_SYNTHESIS, integrationBranch: 'integrate/test-feature' },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'synthesize', events, 1, { dryRun: false });

      const closePrAction = result.actions.find((a) => a.actionId === 'synthesize:close-pr');
      expect(closePrAction).toBeDefined();
      expect(closePrAction!.status).toBe('skipped');
      expect(closePrAction!.message).toBe('No PR to close');
    });

    it('should return skipped when synthesis is undefined', async () => {
      const state = makeState({
        phase: 'synthesize',
        synthesis: undefined,
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'synthesize', events, 1, { dryRun: false });

      const closePrAction = result.actions.find((a) => a.actionId === 'synthesize:close-pr');
      expect(closePrAction).toBeDefined();
      expect(closePrAction!.status).toBe('skipped');
      expect(closePrAction!.message).toBe('No PR to close');
    });
  });

  describe('DeleteFeatureBranches_TasksWithMissingBranches_FiltersCorrectly', () => {
    it('should skip tasks with no branch property and only process those with branches', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {},
        tasks: [
          { id: 'task-1', title: 'Task 1', status: 'pending' },
          { id: 'task-2', title: 'Task 2', status: 'complete', branch: undefined },
          { id: 'task-3', title: 'Task 3', status: 'complete', branch: 'feature/task-3' },
        ],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('outstanding');
      expect(deleteAction!.message).toContain('1 feature branch');
      expect(deleteAction!.resources).toEqual([
        { kind: 'feature-branch', ref: 'feature/task-3', status: 'outstanding' },
      ]);
    });

    it('should skip when all tasks lack branch property', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {},
        tasks: [
          { id: 'task-1', title: 'Task 1', status: 'pending' },
          { id: 'task-2', title: 'Task 2', status: 'complete', branch: undefined },
        ],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('skipped');
      expect(deleteAction!.message).toBe('No feature branches to delete');
    });
  });

  describe('CleanupWorktrees_MissingPath_SkipsWorktree', () => {
    it('should skip worktrees that have no path and continue processing others', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {
          'task-1': { branch: 'feature/task-1', taskId: 'task-1', status: 'active' },
          'task-2': { branch: 'feature/task-2', taskId: 'task-2', status: 'active', path: '/tmp/worktree-2' },
        },
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
      expect(cleanupAction).toBeDefined();
      expect(cleanupAction!.status).toBe('outstanding');
      expect(cleanupAction!.resources).toEqual([
        { kind: 'worktree', ref: '/tmp/worktree-2', status: 'outstanding' },
      ]);
      expect(processStarts.count).toBe(0);
    });
  });

  describe('ExecuteCompensation_PlanPhase_OnlyDelegateAndEarlier', () => {
    /** `plan` comes before `delegate` in `PHASE_ORDER`, and it registers no compensation action. */
    it('should not include synthesize or delegate actions when phase is plan', async () => {
      const state = makeState({ phase: 'plan' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'plan', events, 1, { dryRun: true });

      const actionIds = result.actions.map((a) => a.actionId);

      expect(actionIds.every((id) => !id.startsWith('synthesize:'))).toBe(true);
      expect(actionIds.every((id) => !id.startsWith('delegate:'))).toBe(true);
      expect(result.actions.length).toBe(0);
      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteCompensation_DelegatePhase_IncludesDelegateActionsOnly', () => {
    it('should include delegate-phase actions but not synthesize', async () => {
      const state = makeState({ phase: 'delegate' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: true });

      const actionIds = result.actions.map((a) => a.actionId);

      expect(actionIds.some((id) => id.startsWith('delegate:'))).toBe(true);

      expect(actionIds.every((id) => !id.startsWith('synthesize:'))).toBe(true);
    });
  });

  describe('DeleteFeatureBranches_DryRun_ListsBranchNames', () => {
    it('should list branch names in dry-run message', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {},
        tasks: [
          { id: 'task-1', title: 'Task 1', status: 'complete', branch: 'feature/task-1' },
          { id: 'task-2', title: 'Task 2', status: 'complete', branch: 'feature/task-2' },
        ],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: true });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('dry-run');
      expect(deleteAction!.message).toContain('feature/task-1');
      expect(deleteAction!.message).toContain('feature/task-2');
    });
  });

  describe('CleanupWorktrees_DryRun_ListsWorktreePaths', () => {
    it('should list worktree paths in dry-run message', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: EMPTY_SYNTHESIS,
        worktrees: {
          'task-1': { branch: 'feature/task-1', taskId: 'task-1', status: 'active', path: '/tmp/wt-1' },
          'task-2': { branch: 'feature/task-2', taskId: 'task-2', status: 'active', path: '/tmp/wt-2' },
        },
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: true });

      const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
      expect(cleanupAction).toBeDefined();
      expect(cleanupAction!.status).toBe('dry-run');
      expect(cleanupAction!.message).toContain('/tmp/wt-1');
      expect(cleanupAction!.message).toContain('/tmp/wt-2');
    });
  });

  describe('DeleteIntegrationBranch_RecordsOutstanding', () => {
    /** The cancel does not ask whether the branch exists, so a branch that is already absent stays outstanding. */
    it('should record the integration branch as outstanding without a probe', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: { ...EMPTY_SYNTHESIS, integrationBranch: 'integrate/test-feature' },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-integration-branch');
      expect(deleteAction).toEqual({
        actionId: 'delegate:delete-integration-branch',
        status: 'outstanding',
        message: 'Recorded integration branch as outstanding: integrate/test-feature',
        resources: [{ kind: 'integration-branch', ref: 'integrate/test-feature', status: 'outstanding' }],
      });
      expect(processStarts.count).toBe(0);
    });
  });

  describe('ExecuteCompensation_LogsEvents_ForEachAction', () => {
    it('should produce a compensation event for each executed action', async () => {
      const state = makeState({ phase: 'delegate' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      expect(result.events.length).toBeGreaterThan(0);

      for (const event of result.events) {
        expect(event.type).toBe('compensation');
      }

      const actionCount = result.actions.length;
      expect(result.events.length).toBe(actionCount);

      for (let i = 1; i < result.events.length; i++) {
        expect(result.events[i].sequence).toBeGreaterThan(result.events[i - 1].sequence);
      }

      const branchRecord = result.events.find((event) => event.trigger === 'compensation:delegate:delete-feature-branches');
      expect(branchRecord?.metadata).toMatchObject({ status: 'outstanding' });
      expect(branchRecord?.metadata?.resources).toHaveLength(2);
    });
  });

  describe('ExecuteCompensation_WithCheckpoint_SkipsCompletedActions', () => {
    it('should skip actions already recorded in the checkpoint', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const checkpoint: CompensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };

      const result = await executeCompensation(state, 'synthesize', events, 2, {
        dryRun: false,
        checkpoint,
      });

      const closePrAction = result.actions.find((a) => a.actionId === 'synthesize:close-pr');
      expect(closePrAction).toBeDefined();
      expect(closePrAction!.status).toBe('skipped');
      expect(closePrAction!.message).toContain('Already completed (checkpoint)');

      const delegateActions = result.actions.filter((a) => a.actionId.startsWith('delegate:'));
      expect(delegateActions.length).toBeGreaterThan(0);
      for (const action of delegateActions) {
        expect(action.message).not.toContain('Already completed (checkpoint)');
      }

      expect(processStarts.count).toBe(0);
    });
  });

  describe('ExecuteCompensation_ReturnsCheckpoint', () => {
    it('should return null checkpoint when all actions succeed', async () => {
      const state = makeState({ phase: 'delegate' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      expect(result.success).toBe(true);
      expect(result.checkpoint).toBeNull();
    });
  });

  describe('ExecuteCompensation_WithEmptyCheckpoint_ExecutesAll', () => {
    it('should execute all actions when checkpoint has no completed actions', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const checkpoint: CompensationCheckpoint = {
        completedActions: [],
      };

      const result = await executeCompensation(state, 'synthesize', events, 2, {
        dryRun: false,
        checkpoint,
      });

      for (const action of result.actions) {
        expect(action.message).not.toContain('Already completed (checkpoint)');
      }

      expect(result.actions.length).toBeGreaterThan(0);

      expect(result.checkpoint).toBeNull();
    });
  });

  describe('ExecuteCompensation_WithoutCheckpoint_ExecutesAll', () => {
    it('should execute all actions when no checkpoint option is provided', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: false });

      for (const action of result.actions) {
        expect(action.message).not.toContain('Already completed (checkpoint)');
      }

      expect(result.actions.length).toBeGreaterThan(0);

      expect(result.checkpoint).toBeNull();
    });
  });

  describe('ExecuteCompensation_AllActionsSucceed_ReturnsNullCheckpoint', () => {
    it('should return null checkpoint when all actions succeed', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: false });

      expect(result.success).toBe(true);
      const failedActions = result.actions.filter((a) => a.status === 'failed');
      expect(failedActions.length).toBe(0);

      expect(result.checkpoint).toBeNull();
    });
  });
});
