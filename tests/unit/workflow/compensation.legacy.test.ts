// The `child_process` mock holds only `execFile`, so compensation runs no real shell command.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '../../../src/workflow/types.js';
import type {
  CompensationAction,
  CompensationCheckpoint,
  CompensationOptions,
  CompensationActionResult,
  CompensationResult,
} from '../../../src/workflow/compensation.js';
import { executeCompensation } from '../../../src/workflow/compensation.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const mockedExecFile = vi.mocked(execFile);

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

describe('Compensation', () => {
  /** By default, the `execFile` mock calls its callback with no error, with or without an options argument. */
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb?: unknown) => {
      if (typeof _opts === 'function') {
        (_opts as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      } else if (typeof cb === 'function') {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
      return undefined as never;
    });
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
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      expect(result.actions.length).toBeGreaterThan(0);

      for (const action of result.actions) {
        expect(action.status).toBe('skipped');
      }

      expect(mockedExecFile).not.toHaveBeenCalled();

      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteCompensation_PartialFailure_ContinuesOtherActions', () => {
    it('should continue with remaining actions when one fails and report partial failure', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'gh' && Array.isArray(args) && args.includes('close')) {
          (callback as (err: Error) => void)(new Error('gh: command failed'));
        } else {
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return undefined as never;
      });

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: false });

      const failedActions = result.actions.filter((a) => a.status === 'failed');
      expect(failedActions.length).toBeGreaterThanOrEqual(1);

      const otherActions = result.actions.filter((a) => a.status !== 'failed');
      expect(otherActions.length).toBeGreaterThanOrEqual(1);

      expect(result.success).toBe(false);

      expect(result.errorCode).toBe('COMPENSATION_PARTIAL');
    });
  });

  describe('ExecuteCompensation_DryRun_ListsActionsNoExecution', () => {
    it('should list what would happen in dry-run mode without executing', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: true });

      for (const action of result.actions) {
        expect(action.status).toBe('dry-run');
      }

      expect(mockedExecFile).not.toHaveBeenCalled();

      expect(result.success).toBe(true);

      expect(result.actions.length).toBeGreaterThan(0);
    });
  });

  describe('ExecuteCompensation_CommandInjection_PreventsShellInterpolation', () => {
    /**
     * The branch name is a shell command substitution.
     * `execFile` must get it as one literal argument, not as part of a command string.
     */
    it('should pass branch names as separate arguments to prevent command injection', async () => {
      const maliciousBranch = '$(rm -rf /)';
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {
          'task-1': { branch: maliciousBranch, taskId: 'task-1', status: 'active' },
        },
        tasks: [{ id: 'task-1', title: 'Task 1', status: 'complete', branch: maliciousBranch }],
      });
      const events = makeEvents(1);

      await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const calls = mockedExecFile.mock.calls;

      const callsWithMaliciousBranch = calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.some((arg: string) => arg === maliciousBranch);
      });

      expect(callsWithMaliciousBranch.length).toBeGreaterThan(0);

      for (const call of callsWithMaliciousBranch) {
        const args = call[1] as string[];
        const branchArg = args.find((arg: string) => arg.includes(maliciousBranch));
        expect(branchArg).toBe(maliciousBranch);
      }
    });

    /** In the delegate phase with an integration branch, the delete action runs a command. */
    it('should use cwd from options.stateDir when provided', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: 'integrate/test',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);
      const stateDir = '/custom/state/dir';

      await executeCompensation(state, 'delegate', events, 1, { dryRun: false, stateDir });

      const calls = mockedExecFile.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[2] as { cwd?: string } | undefined;
        expect(options?.cwd).toBe(stateDir);
      }
    });

    /** In the delegate phase with an integration branch, the delete action runs a command. */
    it('should include timeout option in command execution', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: 'integrate/test',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const calls = mockedExecFile.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[2] as { timeout?: number } | undefined;
        expect(options?.timeout).toBeGreaterThan(0);
      }
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
        expect(action.status).toBe('dry-run');
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
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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
        synthesis: {
          integrationBranch: 'integrate/test-feature',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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
      expect(deleteAction!.status).toBe('executed');
      expect(deleteAction!.message).toContain('1 feature branch');
    });

    it('should skip when all tasks lack branch property', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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
      expect(cleanupAction!.status).toBe('executed');

      const worktreeRemoveCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.includes('worktree') && args?.includes('remove');
      });

      expect(worktreeRemoveCalls.length).toBe(1);
      const removeArgs = worktreeRemoveCalls[0][1] as string[];
      expect(removeArgs).toContain('/tmp/worktree-2');
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
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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

  describe('CleanupWorktrees_DryRun_ListsBranchNames', () => {
    it('should list worktree branch names in dry-run message', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
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
      expect(cleanupAction!.message).toContain('feature/task-1');
      expect(cleanupAction!.message).toContain('feature/task-2');
    });
  });

  describe('CleanupWorktrees_OuterCatch_ReturnsFailed', () => {
    /**
     * The read of `worktree.path` is outside the inner try block of the loop.
     * Thus a getter that throws reaches the outer catch, which reports the action as failed.
     */
    it('should trigger outer catch when worktree property access throws', async () => {
      const poisonedWorktree = {
        branch: 'feature/poison',
        taskId: 'task-poison',
        status: 'active',
        get path(): string {
          throw new Error('Poisoned path getter');
        },
      };

      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {
          'task-poison': poisonedWorktree,
        },
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
      expect(cleanupAction).toBeDefined();
      expect(cleanupAction!.status).toBe('failed');
      expect(cleanupAction!.message).toContain('Failed to clean up worktrees');
      expect(cleanupAction!.message).toContain('Poisoned path getter');
    });

    it('should handle non-Error thrown values in outer catch via String()', async () => {
      const poisonedWorktree = {
        branch: 'feature/poison',
        taskId: 'task-poison',
        status: 'active',
        get path(): string {
          throw 'non-error-string-thrown'; // eslint-disable-line no-throw-literal
        },
      };

      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {
          'task-poison': poisonedWorktree,
        },
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
      expect(cleanupAction).toBeDefined();
      expect(cleanupAction!.status).toBe('failed');
      expect(cleanupAction!.message).toContain('non-error-string-thrown');
    });
  });

  describe('DeleteFeatureBranches_OuterCatch_ViaCorruptedIteration', () => {
    /**
     * Inner catches wrap each delete in the loop body, so only the loop itself can reach the outer catch.
     * The test patches `Array.prototype.filter` so that the filtered array of branch names throws when the loop iterates it.
     * The `finally` block restores all mocks and sets the default `execFile` mock again, because `restoreAllMocks` clears it.
     */
    it('should trigger outer catch when branches array iteration throws unexpectedly', async () => {
      const originalFilter = Array.prototype.filter;

      vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], ...args: unknown[]) {
        const result = originalFilter.apply(this, args as Parameters<typeof originalFilter>);

        if (result.length > 0 && typeof result[0] === 'string' && result[0].startsWith('feature/outer-catch')) {
          const throwingArray = [...result];
          const originalIterator = throwingArray[Symbol.iterator].bind(throwingArray);
          let iterCount = 0;
          throwingArray[Symbol.iterator] = function* () {
            const iter = originalIterator();
            for (const val of { [Symbol.iterator]: () => iter }) {
              iterCount++;
              if (iterCount > 0) {
                throw new Error('Iterator corrupted');
              }
              yield val;
            }
          };
          return throwingArray;
        }

        return result;
      });

      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [
          { id: 'task-1', title: 'Task 1', status: 'complete', branch: 'feature/outer-catch-1' },
        ],
      });
      const events = makeEvents(1);

      let result: Awaited<ReturnType<typeof executeCompensation>>;
      try {
        result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });
      } finally {
        vi.restoreAllMocks();
        mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb?: unknown) => {
          if (typeof _opts === 'function') {
            (_opts as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          } else if (typeof cb === 'function') {
            (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          }
          return undefined as never;
        });
      }

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('failed');
      expect(deleteAction!.message).toContain('Failed to delete feature branches');
      expect(deleteAction!.message).toContain('Iterator corrupted');
    });
  });

  describe('DeleteIntegrationBranch_RemoteDeleteFailure_StillSucceeds', () => {
    it('should succeed when remote branch delete fails (inner catch swallows)', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: 'integrate/test-feature',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('push') && argList?.includes('--delete')) {
          (callback as (err: Error) => void)(new Error('remote ref does not exist'));
        } else {
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-integration-branch');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('executed');
      expect(deleteAction!.message).toContain('Deleted integration branch');
    });
  });

  describe('CleanupWorktrees_WorktreeRemoveFailure_StillSucceeds', () => {
    it('should succeed when worktree remove command fails (inner catch swallows)', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {
          'task-1': { branch: 'feature/task-1', taskId: 'task-1', status: 'active', path: '/tmp/wt-1' },
        },
        tasks: [],
      });
      const events = makeEvents(1);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('worktree') && argList?.includes('remove')) {
          (callback as (err: Error) => void)(new Error('worktree not found'));
        } else {
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
      expect(cleanupAction).toBeDefined();
      expect(cleanupAction!.status).toBe('executed');
      expect(cleanupAction!.message).toContain('Cleaned up 1 worktree');
    });
  });

  describe('DeleteIntegrationBranch_Executed_ReturnsSuccess', () => {
    /**
     * Under the default mock, `rev-parse --verify` succeeds, so the local branch exists and is deleted.
     * `ls-remote` returns empty output, so compensation finds no remote branch and sends no `push --delete`.
     */
    it('should delete the local branch it finds and leave an absent remote alone', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: 'integrate/test-feature',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-integration-branch');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('executed');
      expect(deleteAction!.message).toContain('Deleted integration branch: integrate/test-feature');

      const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.includes('branch') && args?.includes('-D');
      });
      const remotePushCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.includes('push') && args?.includes('--delete');
      });

      expect(branchDeleteCalls.length).toBeGreaterThanOrEqual(1);
      expect(remotePushCalls.length).toBe(0);
    });

    /** `branch -D` fails and `rev-parse --verify` still finds the branch, so the action reports failed, not executed. */
    it('should report failed when the delete errors and the branch still exists', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: 'integrate/test-feature',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('branch') && argList?.includes('-D')) {
          (callback as (err: Error) => void)(new Error('branch not found'));
        } else {
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-integration-branch');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('failed');
    });

    /**
     * The first `rev-parse` finds the branch, so compensation tries the delete, and `branch -D` fails.
     * The check after the delete finds no branch, so a delete that lost a race is not a failure.
     */
    it('should report executed when the delete errors but the branch is gone', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: 'integrate/test-feature',
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [],
      });
      const events = makeEvents(1);

      let revParseCalls = 0;
      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('rev-parse')) {
          revParseCalls += 1;
          if (revParseCalls === 1) {
            (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          } else {
            (callback as (err: Error) => void)(new Error('not a valid ref'));
          }
          return undefined as never;
        }
        if (argList?.includes('branch') && argList?.includes('-D')) {
          (callback as (err: Error) => void)(new Error('branch not found'));
          return undefined as never;
        }
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-integration-branch');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('executed');
    });
  });

  describe('DeleteFeatureBranches_RemoteDeleteFailure_StillSucceeds', () => {
    it('should succeed when remote branch push --delete fails (inner catch swallows)', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [
          { id: 'task-1', title: 'Task 1', status: 'complete', branch: 'feature/task-1' },
        ],
      });
      const events = makeEvents(1);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('push') && argList?.includes('--delete')) {
          (callback as (err: Error) => void)(new Error('remote ref not found'));
        } else {
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('executed');
      expect(deleteAction!.message).toContain('Deleted 1 feature branch');
    });

    it('should succeed when both local and remote deletes fail for feature branches', async () => {
      const state = makeState({
        phase: 'delegate',
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        worktrees: {},
        tasks: [
          { id: 'task-1', title: 'Task 1', status: 'complete', branch: 'feature/task-1' },
          { id: 'task-2', title: 'Task 2', status: 'complete', branch: 'feature/task-2' },
        ],
      });
      const events = makeEvents(1);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        (callback as (err: Error) => void)(new Error('command failed'));
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      expect(deleteAction!.status).toBe('executed');
      expect(deleteAction!.message).toContain('Deleted 2 feature branch');
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

      const ghCloseCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return call[0] === 'gh' && args?.includes('close');
      });
      expect(ghCloseCalls.length).toBe(0);
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

    it('should return a checkpoint with completed action IDs on partial failure', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'gh' && Array.isArray(args) && args.includes('close')) {
          (callback as (err: Error) => void)(new Error('gh: command failed'));
        } else {
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return undefined as never;
      });

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: false });

      expect(result.success).toBe(false);
      expect(result.checkpoint).not.toBeNull();
      expect(Array.isArray(result.checkpoint!.completedActions)).toBe(true);

      for (const action of result.actions) {
        if (action.status === 'executed' || action.status === 'skipped') {
          expect(result.checkpoint!.completedActions).toContain(action.actionId);
        }
      }

      const failedActions = result.actions.filter((a) => a.status === 'failed');
      for (const action of failedActions) {
        expect(result.checkpoint!.completedActions).not.toContain(action.actionId);
      }
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
