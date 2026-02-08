import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '../../workflow/types.js';
import type {
  CompensationAction,
  CompensationOptions,
  CompensationActionResult,
  CompensationResult,
} from '../../workflow/compensation.js';
import { executeCompensation } from '../../workflow/compensation.js';

// Mock child_process so no real shell commands run
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';

const mockedExecFileSync = vi.mocked(execFileSync);

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
    // By default, execFileSync succeeds (returns empty buffer)
    mockedExecFileSync.mockReturnValue(Buffer.from(''));
  });

  describe('ExecuteCompensation_AllPhases_RunsReverseOrder', () => {
    it('should run compensation actions in reverse phase order from current phase', async () => {
      // When current phase is "synthesize", actions should run:
      // synthesize (close-pr) -> integrate (delete-integration-branch) -> delegate (cleanup)
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(3);

      const result = await executeCompensation(state, 'synthesize', events, 3, { dryRun: false });

      // Extract the phases from the action results in order
      const actionIds = result.actions.map((a) => a.actionId);

      // synthesize actions should come before integrate actions,
      // which should come before delegate actions (reverse order)
      const synthesizeIdx = actionIds.findIndex((id) => id.startsWith('synthesize:'));
      const integrateIdx = actionIds.findIndex((id) => id.startsWith('integrate:'));
      const delegateIdx = actionIds.findIndex((id) => id.startsWith('delegate:'));

      // All three phase groups should be present
      expect(synthesizeIdx).toBeGreaterThanOrEqual(0);
      expect(integrateIdx).toBeGreaterThanOrEqual(0);
      expect(delegateIdx).toBeGreaterThanOrEqual(0);

      // Reverse order: synthesize before integrate before delegate
      expect(synthesizeIdx).toBeLessThan(integrateIdx);
      expect(integrateIdx).toBeLessThan(delegateIdx);
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
      expect(mockedExecFileSync).not.toHaveBeenCalled();

      // Overall should still succeed
      expect(result.success).toBe(true);
    });
  });

  describe('ExecuteCompensation_PartialFailure_ContinuesOtherActions', () => {
    it('should continue with remaining actions when one fails and report partial failure', async () => {
      const state = makeState({ phase: 'synthesize' });
      const events = makeEvents(2);

      // Make the close-pr command fail, but let other commands succeed
      mockedExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
        if (cmd === 'gh' && args?.includes('close')) {
          throw new Error('gh: command failed');
        }
        return Buffer.from('');
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
      expect(mockedExecFileSync).not.toHaveBeenCalled();

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

      // Verify execFileSync was called with arguments as separate array elements
      // This ensures the malicious string is treated as a literal, not interpreted
      const calls = mockedExecFileSync.mock.calls;

      // Find calls that include the malicious branch
      const callsWithMaliciousBranch = calls.filter((call) => {
        const args = call[1] as string[] | undefined;
        return args?.some((arg) => arg === maliciousBranch);
      });

      // At least one call should have the malicious branch as a literal argument
      expect(callsWithMaliciousBranch.length).toBeGreaterThan(0);

      // The branch should be passed as a separate argument, not part of a command string
      for (const call of callsWithMaliciousBranch) {
        const args = call[1] as string[];
        // The malicious string should be an exact match to one argument
        // (not embedded in a larger string with shell operators)
        const branchArg = args.find((arg) => arg.includes(maliciousBranch));
        expect(branchArg).toBe(maliciousBranch);
      }
    });

    it('should use cwd from options.stateDir when provided', async () => {
      const state = makeState({
        phase: 'integrate',
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

      // Run from integrate phase so the integration branch deletion action executes
      await executeCompensation(state, 'integrate', events, 1, { dryRun: false, stateDir });

      // Verify execFileSync was called with the correct cwd
      const calls = mockedExecFileSync.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[2] as { cwd?: string } | undefined;
        expect(options?.cwd).toBe(stateDir);
      }
    });

    it('should include timeout option in command execution', async () => {
      const state = makeState({
        phase: 'integrate',
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

      // Run from integrate phase so the integration branch deletion action executes
      await executeCompensation(state, 'integrate', events, 1, { dryRun: false });

      // Verify execFileSync was called with a timeout
      const calls = mockedExecFileSync.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[2] as { timeout?: number } | undefined;
        expect(options?.timeout).toBeGreaterThan(0);
      }
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
});
