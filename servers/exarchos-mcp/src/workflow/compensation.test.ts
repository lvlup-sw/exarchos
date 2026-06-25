import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Event } from './types.js';
import { executeCompensation } from './compensation.js';
import { ConcurrencyError } from '../event-store/concurrency-error.js';
import { EventStore } from '../event-store/store.js';

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

  // ─── Sentry #14059285/0 (twin): Phase C append must retry on transient OCC ─
  //
  // The Phase C `branch.delete.executed` append fires AFTER the git side
  // effect runs. A bare append leaks ConcurrencyError as an unhandled
  // exception, leaving the stream stuck at *.requested with no operator
  // signal. Wrapping in `withStateRetry` lets the bounded retry budget
  // absorb the transient signal; the operationId-keyed idempotencyKey
  // guarantees the retry is a no-op once the executed event lands.
  it('DeleteFeatureBranches_PhaseCExecutedAppend_RetriesOnConcurrencyError', async () => {
    let executedAppendAttempts = 0;
    const eventStore = makeMockEventStore((streamId, event) => {
      const ev = event as { type: string };
      if (ev.type === 'branch.delete.executed') {
        executedAppendAttempts++;
        if (executedAppendAttempts === 1) {
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
      return Promise.resolve({ sequence: executedAppendAttempts, type: ev.type });
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: 'feature/phase-c-retry' }],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    // Phase C must have been retried after the first ConcurrencyError;
    // a bare append would have surfaced the error and the action would
    // have failed.
    expect(executedAppendAttempts).toBeGreaterThanOrEqual(2);
    const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.status).toBe('executed');
  });
});

// ─── Wave B / B5: cleanup-worktrees two-event split ─────────────────────────

describe('B5: cleanup-worktrees two-event split', () => {
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

  // B5.2 — Phase-A retry doesn't refire git worktree remove
  it('CleanupWorktrees_PhaseARetry_DoesNotRefireGitWorktreeRemove', async () => {
    // Simulate: eventStore.append throws ConcurrencyError on the FIRST
    // worktree.remove.requested emit, then succeeds on retry. The withStateRetry
    // wrapper retries, but git worktree remove must NOT be re-fired.
    let requestedCallCount = 0;
    const eventStore = makeMockEventStore((streamId, event) => {
      const ev = event as { type?: string };
      if (ev.type === 'worktree.remove.requested') {
        requestedCallCount++;
        if (requestedCallCount === 1) {
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

    // Stub git worktree list to return the worktree (so it's "present" and would be removed)
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
        // Return the worktree path as if it's registered
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          '/tmp/wt-b5-test  abc1234 [feature/b5-test]\n',
          '',
        );
        return undefined as never;
      }
      // Default: succeed
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {
        't1': { branch: 'feature/b5-test', taskId: 't1', status: 'active', path: '/tmp/wt-b5-test' },
      },
      tasks: [],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    // git worktree remove must have been called AT MOST ONCE despite the retry
    const worktreeRemoveCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('worktree') && args?.includes('remove');
    });
    expect(worktreeRemoveCalls.length).toBeLessThanOrEqual(1);

    // The requested emit was retried (called >1 time) but git remove was not re-fired
    expect(requestedCallCount).toBeGreaterThan(1);
  });

  // B5.3 — Idempotent check: worktree already absent
  it('CleanupWorktrees_WorktreeAlreadyAbsent_RecoversWithoutError', async () => {
    // Seed: worktree.remove.requested already committed (simulating a prior interrupted run).
    // Stub git worktree list to NOT include the worktree.
    // Assert: git worktree remove NOT called; executed event emitted with removed = false.
    const appendedEvents: Array<{ type: string; data: unknown }> = [];
    const eventStore = makeMockEventStore((_streamId, event) => {
      const ev = event as { type: string; data: unknown };
      appendedEvents.push({ type: ev.type, data: ev.data });
      return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
    });

    // Stub: git worktree list returns empty (worktree not registered)
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
        // Worktree not in list — absent
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        return undefined as never;
      }
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {
        't1': { branch: 'feature/gone-wt', taskId: 't1', status: 'active', path: '/tmp/wt-already-gone' },
      },
      tasks: [],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    // git worktree remove must NOT have been called
    const worktreeRemoveCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('worktree') && args?.includes('remove');
    });
    expect(worktreeRemoveCalls.length).toBe(0);

    // worktree.remove.executed must be emitted with removed = false
    const executedEvent = appendedEvents.find((e) => e.type === 'worktree.remove.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent!.data as { removed: boolean };
    expect(data.removed).toBe(false);

    // Overall action should succeed (idempotent recovery is not a failure)
    const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanupAction).toBeDefined();
    expect(cleanupAction!.status).toBe('executed');
  });
});

// ─── Wave B / B4.5: delete-feature-branches parity harness ──────────────────
//
// Verifies that both invocation paths (with and without explicit featureId
// override) observe the same two-event sequence shape:
//   [branch.delete.requested, branch.delete.executed]
// per branch, with data fields consistent with the schema.
//
// "Both carriers" in this context means two separate invocations of
// executeCompensation — one without an event store (legacy path, still
// tested by the existing __tests__ suite) and one with a real SQLite-backed
// EventStore (new two-event path). The parity assertion is: the real
// EventStore arm produces the expected two-event sequence in the correct
// order with the correct data shape.

describe('B4.5: delete-feature-branches parity harness (two-event sequence)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-b4-parity-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    // All git commands succeed (branch presence checks return "present")
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        // Branch exists locally
        (callback as (err: null, stdout: string, stderr: string) => void)(null, 'abc1234', '');
        return undefined as never;
      }
      if (argList?.includes('ls-remote') && argList?.includes('--heads')) {
        // Branch exists remotely
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          'abc1234\trefs/heads/feature/parity-branch\n',
          '',
        );
        return undefined as never;
      }
      // Default: succeed (branch delete, push delete, etc.)
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('DeleteFeatureBranches_Parity_BothCarriersObserveTwoEventSequence', async () => {
    const featureId = 'b4-parity-feature';
    const branchName = 'feature/parity-branch';

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: branchName }],
    });

    // ── Arm 1: with event store (two-event split path) ──────────────────────
    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
    });

    // Query all events appended to the stream
    const events = await eventStore.query(featureId);

    // Assert: both event types are present
    const requestedEvents = events.filter((e) => e.type === 'branch.delete.requested');
    const executedEvents = events.filter((e) => e.type === 'branch.delete.executed');

    expect(requestedEvents.length).toBe(1);
    expect(executedEvents.length).toBe(1);

    // Assert: requested appears BEFORE executed in the stream
    const requestedSeq = requestedEvents[0].sequence;
    const executedSeq = executedEvents[0].sequence;
    expect(requestedSeq).toBeLessThan(executedSeq);

    // Assert: both events carry the same operationId (correlation)
    const reqData = requestedEvents[0].data as { operationId: string; branch: string };
    const exeData = executedEvents[0].data as {
      operationId: string;
      branch: string;
      deletedLocally: boolean;
      deletedRemote: boolean;
    };

    expect(reqData.branch).toBe(branchName);
    expect(exeData.branch).toBe(branchName);
    expect(reqData.operationId).toBe(exeData.operationId);
    expect(typeof reqData.operationId).toBe('string');

    // Branch was present on both sides, so both flags should be true
    expect(exeData.deletedLocally).toBe(true);
    expect(exeData.deletedRemote).toBe(true);
  });
});

// ─── Wave B / B5.5: cleanup-worktrees parity harness ────────────────────────

describe('B5.5: cleanup-worktrees parity harness (two-event sequence)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-b5-parity-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    // All git commands succeed; worktree list shows the worktree as present
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
        // Worktree is registered
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          '/tmp/wt-parity  abc1234 [feature/parity-wt]\n',
          '',
        );
        return undefined as never;
      }
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('CleanupWorktrees_Parity_BothCarriersObserveTwoEventSequence', async () => {
    const featureId = 'b5-parity-feature';
    const worktreePath = '/tmp/wt-parity';

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {
        't1': { branch: 'feature/parity-wt', taskId: 't1', status: 'active', path: worktreePath },
      },
      tasks: [],
    });

    // ── Arm 1: with event store (two-event split path) ──────────────────────
    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
    });

    // Query all events appended to the stream
    const events = await eventStore.query(featureId);

    const requestedEvents = events.filter((e) => e.type === 'worktree.remove.requested');
    const executedEvents = events.filter((e) => e.type === 'worktree.remove.executed');

    expect(requestedEvents.length).toBe(1);
    expect(executedEvents.length).toBe(1);

    // Assert: requested appears BEFORE executed in the stream
    const requestedSeq = requestedEvents[0].sequence;
    const executedSeq = executedEvents[0].sequence;
    expect(requestedSeq).toBeLessThan(executedSeq);

    // Assert: both events carry the same operationId and worktreePath
    const reqData = requestedEvents[0].data as { operationId: string; worktreePath: string };
    const exeData = executedEvents[0].data as {
      operationId: string;
      worktreePath: string;
      removed: boolean;
    };

    expect(reqData.worktreePath).toBe(worktreePath);
    expect(exeData.worktreePath).toBe(worktreePath);
    expect(reqData.operationId).toBe(exeData.operationId);
    expect(typeof reqData.operationId).toBe('string');

    // Worktree was present, so removed should be true
    expect(exeData.removed).toBe(true);
  });
});

// ─── #1352: recovery reuses orphaned `*.requested` operationId ──────────────
//
// When compensation crashes after emitting `*.requested` but before
// `*.executed`, the retry must REUSE the orphaned requested event's
// operationId rather than minting a fresh UUID — otherwise the second
// `*.requested` orphans the first and breaks the 1:1 pairing contract of the
// audit trail (Sentry #14059864/1). The recovery functions
// (recoverWorktreeRemoveOperationId / recoverBranchDeleteOperationId) scan the
// stream via eventStore.query() for the most recent unmatched `*.requested`.
//
// The earlier B4/B5 suites set query() → [] so the reuse path was never
// exercised; these tests seed a matching prior `*.requested` (via a
// type-aware query mock) and assert the emitted requested operationId equals
// the seeded one. The no-prior arm asserts a fresh UUID is minted instead.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mock store whose query() is filter-type-aware: it returns the supplied
 * seeded events whose `type` matches the query's `type` filter (mirroring the
 * real backend's per-type filtering), and [] for any unseeded type. The
 * recovery scanners issue one query for `*.requested` and one for
 * `*.executed`; seeding only the requested type (with no matching executed)
 * yields an unmatched requested event whose operationId must be reused.
 */
function makeTypeAwareMockEventStore(
  seeded: ReadonlyArray<{ type: string; data: Record<string, unknown> }>,
  appendImpl?: AppendFn,
) {
  return {
    append: vi.fn().mockImplementation(
      appendImpl ??
        ((_streamId: string, _event: unknown) => Promise.resolve({ sequence: 1, type: 'ok' })),
    ),
    query: vi
      .fn()
      .mockImplementation((_streamId: string, filters?: { type?: string }) => {
        const wanted = filters?.type;
        const matched = wanted == null ? seeded : seeded.filter((e) => e.type === wanted);
        // Shape each as a minimal WorkflowEvent the recovery scanner reads.
        return Promise.resolve(
          matched.map((e, i) => ({
            sequence: i + 1,
            type: e.type,
            data: e.data,
          })),
        );
      }),
    initialize: vi.fn().mockResolvedValue(undefined),
  };
}

describe('#1352: compensation operationId recovery (reuse vs mint)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // All git side effects succeed; presence checks report the resource as
    // present so the executed event records a real removal/deletion.
    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          '/tmp/wt-recover  abc1234 [feature/recover-wt]\n',
          '',
        );
        return undefined as never;
      }
      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        // Branch exists locally.
        (callback as (err: null, stdout: string, stderr: string) => void)(null, 'abc1234', '');
        return undefined as never;
      }
      if (argList?.includes('ls-remote') && argList?.includes('--heads')) {
        // Branch exists remotely.
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          'abc1234\trefs/heads/feature/recover-branch\n',
          '',
        );
        return undefined as never;
      }
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });
  });

  // ── cleanup-worktrees arm ──────────────────────────────────────────────────

  it('Compensation_RecoveryWithUnmatchedRequested_ReusesOperationId (cleanup-worktrees)', async () => {
    const worktreePath = '/tmp/wt-recover';
    const priorOperationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const appendedEvents: Array<{ type: string; data: { operationId: string } }> = [];
    const eventStore = makeTypeAwareMockEventStore(
      // Orphaned prior requested (no matching executed) for THIS worktree.
      [{ type: 'worktree.remove.requested', data: { operationId: priorOperationId, worktreePath } }],
      (_streamId, event) => {
        const ev = event as { type: string; data: { operationId: string } };
        appendedEvents.push({ type: ev.type, data: ev.data });
        return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
      },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {
        t1: { branch: 'feature/recover-wt', taskId: 't1', status: 'active', path: worktreePath },
      },
      tasks: [],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const requested = appendedEvents.find((e) => e.type === 'worktree.remove.requested');
    const executed = appendedEvents.find((e) => e.type === 'worktree.remove.executed');
    expect(requested).toBeDefined();
    expect(executed).toBeDefined();

    // The freshly-emitted requested REUSES the orphaned operationId — it does
    // NOT mint a new UUID. This is the contract the empty-query mock never
    // exercised.
    expect(requested!.data.operationId).toBe(priorOperationId);
    // And the paired executed carries the same id (1:1 pairing preserved).
    expect(executed!.data.operationId).toBe(priorOperationId);

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup!.status).toBe('executed');
  });

  it('Compensation_NoPriorRequested_MintsFreshId (cleanup-worktrees)', async () => {
    const worktreePath = '/tmp/wt-recover';

    const appendedEvents: Array<{ type: string; data: { operationId: string } }> = [];
    const eventStore = makeTypeAwareMockEventStore(
      [], // no prior requested — recovery returns undefined, handler mints fresh
      (_streamId, event) => {
        const ev = event as { type: string; data: { operationId: string } };
        appendedEvents.push({ type: ev.type, data: ev.data });
        return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
      },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {
        t1: { branch: 'feature/recover-wt', taskId: 't1', status: 'active', path: worktreePath },
      },
      tasks: [],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const requested = appendedEvents.find((e) => e.type === 'worktree.remove.requested');
    expect(requested).toBeDefined();
    // A fresh, well-formed UUID was minted (not the recovery sentinel).
    expect(requested!.data.operationId).toMatch(UUID_RE);
  });

  // ── delete-feature-branches arm ────────────────────────────────────────────

  it('Compensation_RecoveryWithUnmatchedRequested_ReusesOperationId (delete-feature-branches)', async () => {
    const branch = 'feature/recover-branch';
    const priorOperationId = '11111111-2222-3333-4444-555555555555';

    const appendedEvents: Array<{ type: string; data: { operationId: string } }> = [];
    const eventStore = makeTypeAwareMockEventStore(
      [{ type: 'branch.delete.requested', data: { operationId: priorOperationId, branch } }],
      (_streamId, event) => {
        const ev = event as { type: string; data: { operationId: string } };
        appendedEvents.push({ type: ev.type, data: ev.data });
        return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
      },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch }],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const requested = appendedEvents.find((e) => e.type === 'branch.delete.requested');
    const executed = appendedEvents.find((e) => e.type === 'branch.delete.executed');
    expect(requested).toBeDefined();
    expect(executed).toBeDefined();

    expect(requested!.data.operationId).toBe(priorOperationId);
    expect(executed!.data.operationId).toBe(priorOperationId);

    const del = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(del!.status).toBe('executed');
  });

  it('Compensation_NoPriorRequested_MintsFreshId (delete-feature-branches)', async () => {
    const branch = 'feature/recover-branch';

    const appendedEvents: Array<{ type: string; data: { operationId: string } }> = [];
    const eventStore = makeTypeAwareMockEventStore(
      [],
      (_streamId, event) => {
        const ev = event as { type: string; data: { operationId: string } };
        appendedEvents.push({ type: ev.type, data: ev.data });
        return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
      },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch }],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const requested = appendedEvents.find((e) => e.type === 'branch.delete.requested');
    expect(requested).toBeDefined();
    expect(requested!.data.operationId).toMatch(UUID_RE);
  });

  // ── regression: an EXECUTED match disqualifies reuse (mints fresh) ──────────
  //
  // If the prior `*.requested` already has a paired `*.executed` with the same
  // operationId, the recovery scanner must NOT reuse it (the operation already
  // completed) — it must mint a fresh id. This guards the `executedOps.has`
  // skip branch in the recovery loop.

  it('Compensation_PriorRequestedAlreadyExecuted_MintsFreshId (delete-feature-branches)', async () => {
    const branch = 'feature/recover-branch';
    const completedOperationId = '99999999-8888-7777-6666-555555555555';

    const appendedEvents: Array<{ type: string; data: { operationId: string } }> = [];
    const eventStore = makeTypeAwareMockEventStore(
      [
        { type: 'branch.delete.requested', data: { operationId: completedOperationId, branch } },
        { type: 'branch.delete.executed', data: { operationId: completedOperationId } },
      ],
      (_streamId, event) => {
        const ev = event as { type: string; data: { operationId: string } };
        appendedEvents.push({ type: ev.type, data: ev.data });
        return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
      },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch }],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const requested = appendedEvents.find((e) => e.type === 'branch.delete.requested');
    expect(requested).toBeDefined();
    // The matched requested already had a paired executed → NOT reused.
    expect(requested!.data.operationId).not.toBe(completedOperationId);
    expect(requested!.data.operationId).toMatch(UUID_RE);
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

// ─── CodeRabbit #3224631272: operational git failures must surface ──────────
//
// Previously, the existence-check helpers (localBranchExists,
// remoteBranchExists, worktreeIsRegistered) swallowed ALL git errors and
// reported the resource as "already absent". A timeout, not-a-repo, or auth
// break would silently produce `deletedLocally: false` + `executed` even
// though nothing was cleaned up.
//
// These tests assert the new narrowed behavior: benign non-zero exits map to
// "absent" (preserving idempotent recovery); operational failures propagate
// so the compensation action surfaces as `failed`.

describe('compensation: operational git failures surface (CodeRabbit #3224631272)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DeleteFeatureBranches_GitRevParseTimesOut_ActionFails', async () => {
    // rev-parse --verify is killed by the COMMAND_TIMEOUT_MS guard.
    // execFile errors with `killed: true` indicate timeout / signal — these
    // must NOT be treated as "branch absent".
    const eventStore = makeMockEventStore();

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        const err = Object.assign(new Error('Command failed: git rev-parse'), {
          killed: true,
          code: null,
          signal: 'SIGTERM' as NodeJS.Signals,
          stderr: '',
        });
        (callback as (err: Error) => void)(err);
        return undefined as never;
      }
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: 'feature/timeout-test' }],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    // The action must surface as failed — NOT silently succeed with the
    // branch reported as already absent.
    const action = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(action).toBeDefined();
    expect(action!.status).toBe('failed');

    // git branch -D must NOT have been called — the precheck propagated.
    const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('branch') && args?.includes('-D');
    });
    expect(branchDeleteCalls.length).toBe(0);
  });

  it('CleanupWorktrees_GitNotARepository_ActionFails', async () => {
    // `git worktree list` runs outside a git repository — stderr contains the
    // "not a git repository" sentinel. This must surface, not be swallowed.
    const eventStore = makeMockEventStore();

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
        const err = Object.assign(
          new Error('Command failed: git worktree list'),
          {
            killed: false,
            code: 128,
            stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
          },
        );
        (callback as (err: Error) => void)(err);
        return undefined as never;
      }
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {
        t1: { branch: 'feature/notrepo', taskId: 't1', status: 'active', path: '/tmp/wt-notrepo' },
      },
      tasks: [],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const action = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(action).toBeDefined();
    expect(action!.status).toBe('failed');

    // worktree remove must NOT have run.
    const removeCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('worktree') && args?.includes('remove');
    });
    expect(removeCalls.length).toBe(0);
  });

  it('DeleteFeatureBranches_BranchAbsentExitCode_StillRecoversCleanly', async () => {
    // Regression for the narrowed catch: a benign non-zero exit (branch
    // not present) must still be treated as "absent" — only operational
    // failures (timeout, not-a-repo, auth) must surface.
    const appendedEvents: Array<{ type: string }> = [];
    const eventStore = makeMockEventStore((_streamId, event) => {
      const ev = event as { type: string };
      appendedEvents.push({ type: ev.type });
      return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
    });

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        // Branch absent — benign exit-128 with the "not a valid object" stderr
        // typical of rev-parse misses. NOT an operational failure.
        const err = Object.assign(
          new Error('Command failed: git rev-parse --verify'),
          {
            killed: false,
            code: 128,
            stderr: "fatal: Needed a single revision\nfatal: Not a valid object name 'feature/absent-test'",
          },
        );
        (callback as (err: Error) => void)(err);
        return undefined as never;
      }
      // ls-remote: empty stdout (absent on remote, but ran successfully).
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return undefined as never;
    });

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: 'feature/absent-test' }],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore: eventStore as unknown as Parameters<typeof executeCompensation>[4]['eventStore'],
      featureId: 'test-feature',
    });

    const action = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(action).toBeDefined();
    expect(action!.status).toBe('executed');

    // branch.delete.executed should be emitted (idempotent recovery succeeded).
    const executedEvent = appendedEvents.find((e) => e.type === 'branch.delete.executed');
    expect(executedEvent).toBeDefined();
  });
});
