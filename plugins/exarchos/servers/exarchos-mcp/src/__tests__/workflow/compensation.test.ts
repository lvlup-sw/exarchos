import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '../../workflow/types.js';
import type {
  CompensationAction,
  CompensationCheckpoint,
  CompensationOptions,
  CompensationActionResult,
  CompensationResult,
} from '../../workflow/compensation.js';
import { executeCompensation } from '../../workflow/compensation.js';

// Mock child_process so no real shell commands run
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const mockedExecFile = vi.mocked(execFile);

// Helper to create a minimal workflow state for testing
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
  beforeEach(() => {
    vi.clearAllMocks();
    // By default, execFile succeeds (calls callback with no error)
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb?: unknown) => {
      if (typeof _opts === 'function') {
        // When called as execFile(cmd, args, cb)
        (_opts as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      } else if (typeof cb === 'function') {
        // When called as execFile(cmd, args, opts, cb)
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
      return undefined as never;
    });
  });

  describe('ExecuteCompensation_AllPhases_RunsReverseOrder', () => {
    it('should run compensation actions in reverse phase order from current phase', async () => {
      // When current phase is "synthesize", actions should run:
      // synthesize (close-pr) -> delegate (delete-integration-branch, cleanup, delete-branches)
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(3);

      const result = await executeCompensation(state, 'synthesize', events, 3, { dryRun: false });

      // Extract the phases from the action results in order
      const actionIds = result.actions.map((a) => a.actionId);

      // synthesize actions should come before delegate actions (reverse phase order)
      const synthesizeIdx = actionIds.findIndex((id) => id.startsWith('synthesize:'));
      const delegateIdx = actionIds.findIndex((id) => id.startsWith('delegate:'));

      // Both phase groups should be present
      expect(synthesizeIdx).toBeGreaterThanOrEqual(0);
      expect(delegateIdx).toBeGreaterThanOrEqual(0);

      // Reverse order: synthesize before delegate
      expect(synthesizeIdx).toBeLessThan(delegateIdx);
    });
  });

  describe('ExecuteCompensation_AlreadyCleaned_SkipsWithNoOp', () => {
    it('should skip actions with no-op when resources do not exist', async () => {
      // State with no PR and no integration branch and no worktrees
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

      // Should still produce action entries (they just get skipped)
      expect(result.actions.length).toBeGreaterThan(0);

      // All actions should be skipped
      for (const action of result.actions) {
        expect(action.status).toBe('skipped');
      }

      // No shell commands should have been executed
      expect(mockedExecFile).not.toHaveBeenCalled();

      // Overall should still succeed
      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteCompensation_PartialFailure_ContinuesOtherActions', () => {
    it('should continue with remaining actions when one fails and report partial failure', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      // Make the close-pr command fail, but let other commands succeed
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

      // Should have a failed action
      const failedActions = result.actions.filter((a) => a.status === 'failed');
      expect(failedActions.length).toBeGreaterThanOrEqual(1);

      // Should also have non-failed actions (executed or skipped)
      const otherActions = result.actions.filter((a) => a.status !== 'failed');
      expect(otherActions.length).toBeGreaterThanOrEqual(1);

      // Overall success should be false
      expect(result.success).toBe(false);

      // Should report partial failure error code
      expect(result.errorCode).toBe('COMPENSATION_PARTIAL');
    });
  });

  describe('ExecuteCompensation_DryRun_ListsActionsNoExecution', () => {
    it('should list what would happen in dry-run mode without executing', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: true });

      // All actions should have dry-run status
      for (const action of result.actions) {
        expect(action.status).toBe('dry-run');
      }

      // No shell commands should have been executed
      expect(mockedExecFile).not.toHaveBeenCalled();

      // Should still be considered successful
      expect(result.success).toBe(true);

      // Should have actions listed (not empty)
      expect(result.actions.length).toBeGreaterThan(0);
    });
  });

  describe('ExecuteCompensation_CommandInjection_PreventsShellInterpolation', () => {
    it('should pass branch names as separate arguments to prevent command injection', async () => {
      // Use a malicious branch name that would cause command injection if interpolated
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

      // Verify execFile was called with arguments as separate array elements
      // This ensures the malicious string is treated as a literal, not interpreted
      const calls = mockedExecFile.mock.calls;

      // Find calls that include the malicious branch
      const callsWithMaliciousBranch = calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.some((arg: string) => arg === maliciousBranch);
      });

      // At least one call should have the malicious branch as a literal argument
      expect(callsWithMaliciousBranch.length).toBeGreaterThan(0);

      // The branch should be passed as a separate argument, not part of a command string
      for (const call of callsWithMaliciousBranch) {
        const args = call[1] as string[];
        // The malicious string should be an exact match to one argument
        // (not embedded in a larger string with shell operators)
        const branchArg = args.find((arg: string) => arg.includes(maliciousBranch));
        expect(branchArg).toBe(maliciousBranch);
      }
    });

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

      // Run from delegate phase so the integration branch deletion action executes
      await executeCompensation(state, 'delegate', events, 1, { dryRun: false, stateDir });

      // Verify execFile was called with the correct cwd
      const calls = mockedExecFile.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[2] as { cwd?: string } | undefined;
        expect(options?.cwd).toBe(stateDir);
      }
    });

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

      // Run from delegate phase so the integration branch deletion action executes
      await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      // Verify execFile was called with a timeout
      const calls = mockedExecFile.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[2] as { timeout?: number } | undefined;
        expect(options?.timeout).toBeGreaterThan(0);
      }
    });
  });

  describe('ExecuteCompensation_UnknownPhase_RunsAllActions', () => {
    it('should run all compensation actions when phase is not in PHASE_ORDER', async () => {
      const state = makeState({ phase: 'unknown-phase' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'unknown-phase', events, 1, { dryRun: true });

      // Should have actions from all phase groups since all phases are included
      expect(result.actions.length).toBeGreaterThan(0);

      // All actions should be dry-run
      for (const action of result.actions) {
        expect(action.status).toBe('dry-run');
      }

      // Should include actions from synthesize AND delegate phases
      // since an unknown phase causes getPhasesInReverseOrder to return ALL phases
      const actionIds = result.actions.map((a) => a.actionId);
      const hasSynthesize = actionIds.some((id) => id.startsWith('synthesize:'));
      const hasDelegate = actionIds.some((id) => id.startsWith('delegate:'));

      expect(hasSynthesize).toBe(true);
      expect(hasDelegate).toBe(true);

      // Reverse order: synthesize before delegate
      const synthesizeIdx = actionIds.findIndex((id) => id.startsWith('synthesize:'));
      const delegateIdx = actionIds.findIndex((id) => id.startsWith('delegate:'));

      expect(synthesizeIdx).toBeLessThan(delegateIdx);

      expect(result.success).toBe(true);
    });

    it('should run all compensation actions with execution when phase is unknown', async () => {
      const state = makeState({ phase: 'unknown-phase' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'unknown-phase', events, 1, { dryRun: false });

      // Should have actions from all phase groups
      expect(result.actions.length).toBeGreaterThan(0);

      // Should include actions from both registered phases (synthesize and delegate)
      const actionIds = result.actions.map((a) => a.actionId);
      expect(actionIds.some((id) => id.startsWith('synthesize:'))).toBe(true);
      expect(actionIds.some((id) => id.startsWith('delegate:'))).toBe(true);
    });
  });

  describe('ExecuteCompensation_IdeatePhase_OnlyEarlyActions', () => {
    it('should only include actions up to ideate phase (no actions since ideate has none)', async () => {
      // State at ideate phase with no resources created yet
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

      const result = await executeCompensation(state, 'ideate', events, 1, { dryRun: false });

      // ideate has no registered compensation actions, so result should be empty
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

      // Find the close-pr action
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
      // Should execute (not skip) since at least one task has a branch
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

      // Only the worktree with a path should have triggered a git command
      const worktreeRemoveCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.includes('worktree') && args?.includes('remove');
      });

      // Should only have 1 remove call (for task-2 which has a path)
      expect(worktreeRemoveCalls.length).toBe(1);
      const removeArgs = worktreeRemoveCalls[0][1] as string[];
      expect(removeArgs).toContain('/tmp/worktree-2');
    });
  });

  describe('ExecuteCompensation_PlanPhase_OnlyDelegateAndEarlier', () => {
    it('should not include synthesize or delegate actions when phase is plan', async () => {
      const state = makeState({ phase: 'plan' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'plan', events, 1, { dryRun: true });

      const actionIds = result.actions.map((a) => a.actionId);

      // plan is before delegate in PHASE_ORDER, so only ideate and plan phases included
      // Neither has registered actions, so there should be no actions
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

      // delegate phase should have delegate actions
      expect(actionIds.some((id) => id.startsWith('delegate:'))).toBe(true);

      // Should NOT have synthesize actions
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
    it('should trigger outer catch when worktree property access throws', async () => {
      // The outer catch (lines 189-196) wraps the entire for-loop body.
      // Lines 176-177 (worktree.path access and the continue check) are OUTSIDE
      // the inner try/catch. A throwing getter on .path triggers the outer catch.
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
    it('should trigger outer catch when branches array iteration throws unexpectedly', async () => {
      // The outer catch (lines 248-255) wraps the for-loop for branches.
      // The for-loop body is: inner try (local delete) + inner try (remote delete).
      // Everything in the for-loop body is wrapped by inner catches.
      // However, we can trigger the outer catch by corrupting the branches array
      // after it's created but before iteration completes.
      // We achieve this by using a Proxy on the tasks array that produces
      // a branches array with a corrupted Symbol.iterator.

      // Override Array.prototype.filter to return an array with a throwing iterator
      // only for the specific call in deleteFeatureBranches
      const originalFilter = Array.prototype.filter;

      // We need to intercept the specific filter call that creates the branches array.
      // The code does: tasks.map(t => t.branch).filter(b => !!b)
      // The filter is called on the mapped array.
      vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], ...args: unknown[]) {
        const result = originalFilter.apply(this, args as Parameters<typeof originalFilter>);

        // The deleteFeatureBranches filter happens on the mapped branches array
        // Check if this looks like the branches filter (array of strings/undefined)
        if (result.length > 0 && typeof result[0] === 'string' && result[0].startsWith('feature/outer-catch')) {
          // Return a proxy that throws during for-of iteration
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
        // Guarantee restore even if the test throws, preventing mock leakage
        vi.restoreAllMocks();
        // Re-establish the execFile mock since restoreAllMocks clears it
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

      // Make remote delete (push --delete) fail
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
      // Still succeeds because inner catch swallows remote delete failure
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

      // Make worktree remove fail
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
      // Still succeeds because inner catch swallows the worktree remove failure
      expect(cleanupAction!.status).toBe('executed');
      expect(cleanupAction!.message).toContain('Cleaned up 1 worktree');
    });
  });

  describe('DeleteIntegrationBranch_Executed_ReturnsSuccess', () => {
    it('should successfully delete integration branch when it exists and commands succeed', async () => {
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

      // Should have called git branch -D and git push origin --delete
      const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.includes('branch') && args?.includes('-D');
      });
      const remotePushCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.includes('push') && args?.includes('--delete');
      });

      expect(branchDeleteCalls.length).toBeGreaterThanOrEqual(1);
      expect(remotePushCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should still succeed when local branch delete fails but remote succeeds', async () => {
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

      // Make local branch delete fail, but remote succeeds
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
      // Still succeeds because inner catch blocks swallow failures
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

      // Make remote delete fail for all branches
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
      // Still succeeds because inner catch swallows the remote delete failure
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

      // Make all git commands fail
      mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        (callback as (err: Error) => void)(new Error('command failed'));
        return undefined as never;
      });

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
      expect(deleteAction).toBeDefined();
      // Still 'executed' because inner catches swallow individual failures
      expect(deleteAction!.status).toBe('executed');
      expect(deleteAction!.message).toContain('Deleted 2 feature branch');
    });
  });

  describe('ExecuteCompensation_LogsEvents_ForEachAction', () => {
    it('should produce a compensation event for each executed action', async () => {
      const state = makeState({ phase: 'delegate' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      // Should have compensation events
      expect(result.events.length).toBeGreaterThan(0);

      // Each event should be of type 'compensation'
      for (const event of result.events) {
        expect(event.type).toBe('compensation');
      }

      // Number of events should match number of actions that were executed or skipped (not dry-run)
      const actionCount = result.actions.length;
      expect(result.events.length).toBe(actionCount);

      // Events should have incrementing sequence numbers
      for (let i = 1; i < result.events.length; i++) {
        expect(result.events[i].sequence).toBeGreaterThan(result.events[i - 1].sequence);
      }
    });
  });

  describe('ExecuteCompensation_WithCheckpoint_SkipsCompletedActions', () => {
    it('should skip actions already recorded in the checkpoint', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      // Provide a checkpoint indicating 'synthesize:close-pr' already completed
      const checkpoint: CompensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };

      const result = await executeCompensation(state, 'synthesize', events, 2, {
        dryRun: false,
        checkpoint,
      });

      // The close-pr action should be skipped with checkpoint message
      const closePrAction = result.actions.find((a) => a.actionId === 'synthesize:close-pr');
      expect(closePrAction).toBeDefined();
      expect(closePrAction!.status).toBe('skipped');
      expect(closePrAction!.message).toContain('Already completed (checkpoint)');

      // Other actions (delegate phase) should still execute normally
      const delegateActions = result.actions.filter((a) => a.actionId.startsWith('delegate:'));
      expect(delegateActions.length).toBeGreaterThan(0);
      for (const action of delegateActions) {
        // Delegate actions should be executed or skipped-by-condition (not checkpoint-skipped)
        expect(action.message).not.toContain('Already completed (checkpoint)');
      }

      // The gh close command should NOT have been called since close-pr was checkpointed
      const ghCloseCalls = mockedExecFile.mock.calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return call[0] === 'gh' && args?.includes('close');
      });
      expect(ghCloseCalls.length).toBe(0);
    });
  });

  describe('ExecuteCompensation_ReturnsCheckpoint', () => {
    it('should return a checkpoint with IDs of all executed and skipped actions', async () => {
      const state = makeState({ phase: 'delegate' });
      const events = makeEvents(1);

      const result = await executeCompensation(state, 'delegate', events, 1, { dryRun: false });

      // Result should include checkpoint
      expect(result.checkpoint).toBeDefined();
      expect(Array.isArray(result.checkpoint.completedActions)).toBe(true);

      // All actions that were executed or skipped should appear in checkpoint
      for (const action of result.actions) {
        if (action.status === 'executed' || action.status === 'skipped') {
          expect(result.checkpoint.completedActions).toContain(action.actionId);
        }
      }

      // Failed actions should NOT appear in checkpoint
      const failedActions = result.actions.filter((a) => a.status === 'failed');
      for (const action of failedActions) {
        expect(result.checkpoint.completedActions).not.toContain(action.actionId);
      }
    });
  });

  describe('ExecuteCompensation_WithEmptyCheckpoint_ExecutesAll', () => {
    it('should execute all actions when checkpoint has no completed actions', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      // Empty checkpoint — no previously completed actions
      const checkpoint: CompensationCheckpoint = {
        completedActions: [],
      };

      const result = await executeCompensation(state, 'synthesize', events, 2, {
        dryRun: false,
        checkpoint,
      });

      // No actions should be checkpoint-skipped
      for (const action of result.actions) {
        expect(action.message).not.toContain('Already completed (checkpoint)');
      }

      // Actions should still execute or be condition-skipped as normal
      expect(result.actions.length).toBeGreaterThan(0);

      // Checkpoint should be returned with all executed/skipped action IDs
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint.completedActions.length).toBeGreaterThan(0);
    });
  });

  describe('ExecuteCompensation_WithoutCheckpoint_ExecutesAll', () => {
    it('should execute all actions when no checkpoint option is provided', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      // No checkpoint in options at all (backward compatibility)
      const result = await executeCompensation(state, 'synthesize', events, 2, { dryRun: false });

      // No actions should be checkpoint-skipped
      for (const action of result.actions) {
        expect(action.message).not.toContain('Already completed (checkpoint)');
      }

      // Actions should still execute or be condition-skipped as normal
      expect(result.actions.length).toBeGreaterThan(0);

      // Checkpoint should still be returned in the result
      expect(result.checkpoint).toBeDefined();
      expect(Array.isArray(result.checkpoint.completedActions)).toBe(true);
    });
  });
});
