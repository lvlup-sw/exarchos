import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from './types.js';
import { executeCompensation } from './compensation.js';
import { ConcurrencyError } from '../event-store/concurrency-error.js';

// Mock child_process so no real shell commands run
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const mockedExecFile = vi.mocked(execFile);

// ─── Mock event store helper ─────────────────────────────────────────────────

type AppendFn = (streamId: string, event: unknown, options?: unknown) => Promise<unknown>;

function makeMockEventStore(appendImpl?: AppendFn) {
  return {
    append: vi.fn().mockImplementation(
      appendImpl ??
        ((_streamId: string, _event: unknown) => Promise.resolve({ sequence: 1, type: 'ok' })),
    ),
    query: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    featureId: 'test-feature',
    workflowType: 'feature',
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

// ─── Wave B / B4: delete-feature-branches two-event split ───────────────────

describe('B4: delete-feature-branches two-event split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all git commands succeed
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb?: unknown) => {
      if (typeof _opts === 'function') {
        (_opts as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      } else if (typeof cb === 'function') {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
      return undefined as never;
    });
  });

  // B4.2 — Phase-A retry doesn't refire git branch deletion
  it('DeleteFeatureBranches_PhaseARetry_DoesNotRefireGitDeletion', async () => {
    // Simulate: eventStore.append throws ConcurrencyError on the FIRST
    // branch.delete.requested emit, then succeeds on retry. The withStateRetry
    // wrapper retries the append, but git branch -D must NOT be re-fired.
    let requestedCallCount = 0;
    const eventStore = makeMockEventStore((streamId, event) => {
      const ev = event as { type?: string };
      if (ev.type === 'branch.delete.requested') {
        requestedCallCount++;
        if (requestedCallCount === 1) {
          // First attempt fails with ConcurrencyError — triggers withStateRetry
          return Promise.reject(
            new ConcurrencyError({
              streamId: streamId as string,
              expected: 0,
              actual: 1,
              operation: 'append',
            }),
          );
        }
      }
      return Promise.resolve({ sequence: requestedCallCount, type: ev.type });
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: 'feature/b4-test' }],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    // git branch -D must have been called AT MOST ONCE despite the retry
    const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('branch') && args?.includes('-D');
    });
    expect(branchDeleteCalls.length).toBeLessThanOrEqual(1);

    // The requested emit was retried (called >1 time) but git was not
    expect(requestedCallCount).toBeGreaterThan(1);
  });

  // B4.3 — Idempotent check: branch already absent
  it('DeleteFeatureBranches_BranchAlreadyAbsent_RecoversWithoutError', async () => {
    // Seed: branch.delete.requested already committed (simulating a prior interrupted run).
    // Stub branch-existence checks to return "not present" (git rev-parse and ls-remote exit 1).
    // Assert: git branch -D NOT called; executed event emitted with deletedLocally/deletedRemote = false.
    const appendedEvents: Array<{ type: string; data: unknown }> = [];
    const eventStore = makeMockEventStore((_streamId, event) => {
      const ev = event as { type: string; data: unknown };
      appendedEvents.push({ type: ev.type, data: ev.data });
      return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
    });

    // Stub: git rev-parse --verify → exit 1 (branch not present locally)
    // Stub: git ls-remote --heads → empty output (not present remotely)
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        // Branch doesn't exist locally — report error
        (callback as (err: Error) => void)(new Error('fatal: not a valid object name'));
        return undefined as never;
      }
      if (argList?.includes('ls-remote') && argList?.includes('--heads')) {
        // Branch doesn't exist remotely — empty output means absent
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        return undefined as never;
      }
      // Any other command succeeds
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: 'feature/already-gone' }],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    // git branch -D must NOT have been called (branch doesn't exist)
    const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('branch') && args?.includes('-D');
    });
    expect(branchDeleteCalls.length).toBe(0);

    // branch.delete.executed must be emitted with both flags = false
    const executedEvent = appendedEvents.find((e) => e.type === 'branch.delete.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent!.data as { deletedLocally: boolean; deletedRemote: boolean };
    expect(data.deletedLocally).toBe(false);
    expect(data.deletedRemote).toBe(false);

    // Overall action should succeed (idempotent recovery is not a failure)
    const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.status).toBe('executed');
  });
});

// ─── T-16: Compensation action error handling ───────────────────────────────

describe('Compensation action error handling (close-pr)', () => {
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

  it('ClosePR_GhCommandFails_ReturnsFailed', async () => {
    // Instead of trying to reach dead code, test the equivalent close-pr
    // action which has a reachable catch block with the same error handling
    // pattern (lines 88-94).
    const state = makeState({
      phase: 'synthesize',
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: 'https://github.com/org/repo/pull/42',
        prFeedback: [],
      },
      worktrees: {},
      tasks: [],
    });
    const events = makeEvents(1);

    // Make gh pr close fail with an Error
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];
      if (cmd === 'gh' && argList?.includes('close')) {
        (callback as (err: Error) => void)(new Error('gh: failed to close PR'));
      } else {
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
      return undefined as never;
    });

    const result = await executeCompensation(state, 'synthesize', events, 1, { dryRun: false });

    const closePrAction = result.actions.find(a => a.actionId === 'synthesize:close-pr');
    expect(closePrAction).toBeDefined();
    expect(closePrAction!.status).toBe('failed');
    expect(closePrAction!.message).toContain('Failed to close PR');
    expect(closePrAction!.message).toContain('gh: failed to close PR');
  });

  it('ClosePR_NonErrorThrown_StringifiesMessage', async () => {
    // Test the String(err) path: when a non-Error object is thrown,
    // the catch block should use String(err) to produce a message.
    const state = makeState({
      phase: 'synthesize',
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: 'https://github.com/org/repo/pull/42',
        prFeedback: [],
      },
      worktrees: {},
      tasks: [],
    });
    const events = makeEvents(1);

    // Make gh pr close throw a non-Error value (number)
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];
      if (cmd === 'gh' && argList?.includes('close')) {
        // Throw a non-Error value to exercise the String(err) path
        (callback as (err: unknown) => void)(42);
      } else {
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
      return undefined as never;
    });

    const result = await executeCompensation(state, 'synthesize', events, 1, { dryRun: false });

    const closePrAction = result.actions.find(a => a.actionId === 'synthesize:close-pr');
    expect(closePrAction).toBeDefined();
    expect(closePrAction!.status).toBe('failed');
    // The String(err) path should convert the non-Error to a string
    expect(closePrAction!.message).toContain('Failed to close PR');
    expect(closePrAction!.message).toContain('42');
  });
});
