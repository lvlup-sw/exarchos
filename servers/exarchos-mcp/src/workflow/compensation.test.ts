import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Event } from './types.js';
import { executeCompensation } from './compensation.js';
import { ConcurrencyError } from '../events/concurrency-error.js';
import { EventStore } from '../events/store.js';

// Mock ONLY `child_process.execFile` (the async side-effect path the SUT shells
// git through) — the rest of the module stays REAL so the INV-14 dirty-guard's
// `defaultGitRunner` (spawnSync-backed) and the real-worktree test setup below
// (execFileSync) run actual git. Spreading the actual module keeps
// `spawnSync`/`execFileSync` defined; without it the whole module would be
// replaced and those would be `undefined`.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile, execFileSync } from 'child_process';
import * as fsSync from 'node:fs';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WORKTREES_STREAM, defaultGitRunner } from '../orchestrate/worktree/manager.js';
import { createWorktreesReducer } from '../orchestrate/worktree/projections/worktrees.js';
import type { RealpathResolver } from '../orchestrate/worktree/pure/path-containment.js';
import { canonicalWorktreeId } from '../orchestrate/worktree/pure/path-containment.js';
import type { WorkflowEvent } from '../events/schemas.js';

const mockedExecFile = vi.mocked(execFile);

/** Identity resolver — `path.resolve` already normalised the input. */
const identityRealpath: RealpathResolver = (p) => p;

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
    await rmrfAsync(tmpDir);
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
    await rmrfAsync(tmpDir);
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
      realpath: identityRealpath,
    });

    // DR-3: the remove pair lands on the SINGLETON `worktrees` stream, NOT the
    // `featureId` stream — the whole point of the unification.
    const events = await eventStore.query('worktrees');

    const requestedEvents = events.filter((e) => e.type === 'worktree.remove.requested');
    const executedEvents = events.filter((e) => e.type === 'worktree.remove.executed');

    expect(requestedEvents.length).toBe(1);
    expect(executedEvents.length).toBe(1);

    // The `featureId` stream carries NONE of the worktree.remove pair now.
    const featureStream = await eventStore.query(featureId);
    expect(featureStream.some((e) => e.type === 'worktree.remove.requested')).toBe(false);
    expect(featureStream.some((e) => e.type === 'worktree.remove.executed')).toBe(false);

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

// ─── Task 009 / DR-3 + DR-1: unify worktree.remove onto the `worktrees` stream ─
//
// Compensation-triggered worktree teardown historically appended
// `worktree.remove.*` to the `featureId` stream, so those removals never reached
// the singleton `worktrees@v1` view — the DIM-1 single-source violation (the view
// showed a live entry for a worktree that was actually removed). These tests pin
// the unified behavior against a REAL SQLite EventStore:
//   1. Adopt-then-remove on the `worktrees` stream, so the terminal drop is NOT
//      vacuous and the view genuinely loses the entry.
//   2. A crash between requested and executed (on the unified stream) resumes
//      under the ORIGINAL operationId — no second pair.
//   3. A PRE-unification crash (requested stranded on the legacy `featureId`
//      stream) resumes under that original operationId, completing the pair on
//      the `worktrees` stream.
//   4. DR-1: the `git worktree remove` call site retries on transient
//      `index.lock` contention.

describe('Task 009: worktree.remove unified onto the `worktrees` stream (DR-3/DR-1)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-task009-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * execFile mock: `git worktree list` reports `registeredPath` as present, the
   * `git worktree remove` succeeds, everything else succeeds. When
   * `registeredPath` is null nothing is registered (worktree already absent).
   */
  function stubWorktreeRegistered(registeredPath: string | null): void {
    mockedExecFile.mockImplementation(
      (cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('worktree') && argList?.includes('list')) {
          const stdout = registeredPath ? `${registeredPath}  abc1234 [feature/x]\n` : '';
          (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, '');
          return undefined as never;
        }
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        return undefined as never;
      },
    );
  }

  const foldWorktrees = (events: readonly WorkflowEvent[]) => {
    const reducer = createWorktreesReducer(identityRealpath);
    return events.reduce((acc, ev) => reducer.apply(acc, ev), reducer.initial);
  };

  it('Compensation_WorktreeRemove_AdoptsThenEmitsPairOnWorktreesStream_ViewDropsEntry', async () => {
    const featureId = 'task009-adopt-feature';
    const worktreePath = '/tmp/wt-adopt-drop';
    const worktreeId = canonicalWorktreeId(worktreePath, identityRealpath);
    stubWorktreeRegistered(worktreePath);

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: { t1: { branch: 'feature/x', taskId: 't1', status: 'active', path: worktreePath } },
      tasks: [],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
      realpath: identityRealpath,
    });

    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);

    // Adopt-gate fired: the worktree the manager never governed is adopted FIRST.
    const adopted = worktreesEvents.filter((e) => e.type === 'worktree.adopted');
    const requested = worktreesEvents.filter((e) => e.type === 'worktree.remove.requested');
    const executed = worktreesEvents.filter((e) => e.type === 'worktree.remove.executed');
    expect(adopted.length).toBe(1);
    expect(requested.length).toBe(1);
    expect(executed.length).toBe(1);
    expect((adopted[0].data as { worktreeId: string }).worktreeId).toBe(worktreeId);

    // Ordering: adopted → requested → executed on the SAME stream.
    expect(adopted[0].sequence).toBeLessThan(requested[0].sequence);
    expect(requested[0].sequence).toBeLessThan(executed[0].sequence);

    // The `featureId` stream carries NONE of the worktree lifecycle now.
    const featureEvents = await eventStore.query(featureId);
    expect(featureEvents.some((e) => e.type.startsWith('worktree.'))).toBe(false);

    // The view genuinely DROPS the entry — and, critically, the drop is NOT
    // vacuous: fold everything BEFORE the terminal and the entry is present
    // (the adopt created a real entry production, not a seeded stand-in).
    const beforeTerminal = foldWorktrees(
      worktreesEvents.filter((e) => e.type !== 'worktree.remove.executed'),
    );
    expect(beforeTerminal.worktrees[worktreeId]).toBeDefined();
    const finalView = foldWorktrees(worktreesEvents);
    expect(worktreeId in finalView.worktrees).toBe(false);
  });

  it('Compensation_CrashBetweenRequestedAndExecuted_ResumesIdempotently', async () => {
    const featureId = 'task009-crash-feature';
    const worktreePath = '/tmp/wt-crash-resume';
    const worktreeId = canonicalWorktreeId(worktreePath, identityRealpath);
    const crashedOperationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    stubWorktreeRegistered(worktreePath);

    // Seed a crash mid-teardown ON THE UNIFIED STREAM: adopted + requested, no
    // executed. Same idempotency keys production uses, so the resume dedupes.
    await eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.adopted',
        data: { worktreeId, path: worktreePath, featureId, ownerPid: null, ownerStartedAt: null, operationId: 'seed-adopt' },
      },
      { idempotencyKey: `worktree.adopted:${worktreeId}` },
    );
    await eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.remove.requested',
        data: { operationId: crashedOperationId, worktreePath, worktreeId },
      },
      { idempotencyKey: `worktree.remove.requested:${crashedOperationId}` },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: { t1: { branch: 'feature/x', taskId: 't1', status: 'active', path: worktreePath } },
      tasks: [],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
      realpath: identityRealpath,
    });

    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);
    const requested = worktreesEvents.filter((e) => e.type === 'worktree.remove.requested');
    const executed = worktreesEvents.filter((e) => e.type === 'worktree.remove.executed');
    const adopted = worktreesEvents.filter((e) => e.type === 'worktree.adopted');

    // No SECOND pair: the crashed requested is reused (idempotency-key dedup),
    // and adopt is skipped (entry already governed) — exactly one of each.
    expect(requested.length).toBe(1);
    expect(executed.length).toBe(1);
    expect(adopted.length).toBe(1);
    expect((requested[0].data as { operationId: string }).operationId).toBe(crashedOperationId);
    expect((executed[0].data as { operationId: string; removed: boolean }).operationId).toBe(
      crashedOperationId,
    );
    expect((executed[0].data as { removed: boolean }).removed).toBe(true);

    // The view drops the entry after the resumed terminal.
    expect(worktreeId in foldWorktrees(worktreesEvents).worktrees).toBe(false);
  });

  it('Compensation_PreDeployCrashLegacyFeatureStreamRequested_ResumedUnderOriginalOperationId', async () => {
    const featureId = 'task009-legacy-feature';
    const worktreePath = '/tmp/wt-legacy-resume';
    const worktreeId = canonicalWorktreeId(worktreePath, identityRealpath);
    const legacyOperationId = 'bbbbbbbb-5555-6666-7777-888888888888';
    stubWorktreeRegistered(worktreePath);

    // Seed a PRE-unification crash: `worktree.remove.requested` stranded on the
    // LEGACY `featureId` stream (no worktreeId, no adopted, no worktrees-stream
    // events) with no paired executed.
    await eventStore.append(
      featureId,
      {
        type: 'worktree.remove.requested',
        data: { operationId: legacyOperationId, worktreePath },
      },
      { idempotencyKey: `worktree.remove.requested:${legacyOperationId}` },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: { t1: { branch: 'feature/x', taskId: 't1', status: 'active', path: worktreePath } },
      tasks: [],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
      realpath: identityRealpath,
    });

    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);
    const requested = worktreesEvents.filter((e) => e.type === 'worktree.remove.requested');
    const executed = worktreesEvents.filter((e) => e.type === 'worktree.remove.executed');
    const adopted = worktreesEvents.filter((e) => e.type === 'worktree.adopted');

    // Resumed under the ORIGINAL operationId — the pair is COMPLETED on the
    // `worktrees` stream, and the untracked worktree is adopted first.
    expect(adopted.length).toBe(1);
    expect(requested.length).toBe(1);
    expect(executed.length).toBe(1);
    expect((requested[0].data as { operationId: string }).operationId).toBe(legacyOperationId);
    expect((executed[0].data as { operationId: string }).operationId).toBe(legacyOperationId);

    // The legacy `featureId` stream is left as-is: its orphaned requested stays,
    // and NO executed is retro-fitted there (the pair now lives on `worktrees`).
    const featureEvents = await eventStore.query(featureId);
    expect(featureEvents.filter((e) => e.type === 'worktree.remove.requested').length).toBe(1);
    expect(featureEvents.some((e) => e.type === 'worktree.remove.executed')).toBe(false);

    // The unified view drops the entry.
    expect(worktreeId in foldWorktrees(worktreesEvents).worktrees).toBe(false);
  });

  it('Compensation_WorktreeRemove_IndexLockContention_RetriesRemove (DR-1)', async () => {
    const featureId = 'task009-lock-feature';
    const worktreePath = '/tmp/wt-lock-retry';

    // `git worktree remove` fails with a transient index.lock error on the FIRST
    // attempt, succeeds on the second. `git worktree list` always reports it as
    // registered so the failure would surface if the retry wrap were absent.
    let removeAttempts = 0;
    mockedExecFile.mockImplementation(
      (cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('worktree') && argList?.includes('list')) {
          (callback as (err: null, stdout: string, stderr: string) => void)(
            null,
            `${worktreePath}  abc1234 [feature/x]\n`,
            '',
          );
          return undefined as never;
        }
        if (argList?.includes('worktree') && argList?.includes('remove')) {
          removeAttempts += 1;
          if (removeAttempts === 1) {
            (callback as (err: Error) => void)(
              new Error(
                `fatal: Unable to create '/repo/.git/worktrees/x/index.lock': File exists.`,
              ),
            );
            return undefined as never;
          }
          (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          return undefined as never;
        }
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        return undefined as never;
      },
    );

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: { t1: { branch: 'feature/x', taskId: 't1', status: 'active', path: worktreePath } },
      tasks: [],
    });

    const result = await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
      realpath: identityRealpath,
      // Inject a no-op sleep + zero jitter so the retry is instant + deterministic.
      indexLockRetry: { sleep: async () => {}, jitter: () => 0 },
    });

    // The remove was RETRIED past the transient lock contention (2 attempts),
    // and the action succeeded with the terminal recording removed=true.
    expect(removeAttempts).toBe(2);
    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup!.status).toBe('executed');
    const executed = (await eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'worktree.remove.executed',
    );
    expect(executed.length).toBe(1);
    expect((executed[0].data as { removed: boolean }).removed).toBe(true);
  });
});

// ─── Task 010 / DR-3: INV-14 teardown dirty-guard (never force-remove work) ──
//
// HIGH-tier, boundary-touching. The cancel-compensation teardown historically
// `--force`-removed every worktree with NO dirty guard, so uncommitted work —
// INCLUDING untracked-only changes — in a cancelled workflow's worktree was
// destroyed (the Claude Code #55724 data-loss mode). These tests pin the guard
// against a REAL git worktree (real untracked file, no hand-mock of the dirty
// probe): a dirty worktree is skipped-and-surfaced with a scannable reason and
// NEVER `--force`-removed; a clean worktree is removed exactly as before.
//
// Real substrate: a real git repo + worktree per test (the SUT's `defaultGitRunner`
// dirty probe is real spawnSync git); the `execFile`-shelled side effects
// (`git worktree list` / `git worktree remove`) stay mocked so the removal path
// is observable without mutating the real repo.

describe('Task 010: teardown dirty-guard (INV-14 / DR-3)', () => {
  let repoDir: string;
  let worktreePath: string;
  let stateDir: string;
  let eventStore: EventStore;

  /** Real git in `cwd` (child_process is spread-actual, so execFileSync is real). */
  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args as string[], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  }

  /** True if any mocked execFile call was `git worktree remove … --force`. */
  function forceRemoveCalls(): unknown[][] {
    return mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return (
        args?.includes('worktree') && args?.includes('remove') && args?.includes('--force')
      );
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-task010-'));
    // Real repo with one commit so a worktree can be added off a real branch.
    git(repoDir, ['init', '-q', '-b', 'work']);
    git(repoDir, ['config', 'user.email', 'task010@example.com']);
    git(repoDir, ['config', 'user.name', 'Task010 Test']);
    git(repoDir, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# dirty-guard test\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'init']);

    worktreePath = path.join(repoDir, 'wt');
    git(repoDir, ['worktree', 'add', '-q', worktreePath, '-b', 'feature/x']);

    // Real event store (the DR-3 unified `worktrees` stream lands here).
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-task010-state-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();

    // Mock ONLY the execFile side effects: report the worktree as registered and
    // let `git worktree remove` succeed. The dirty probe does NOT go through here
    // — it runs real spawnSync git via `defaultGitRunner`.
    mockedExecFile.mockImplementation(
      (cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const argList = args as string[];
        if (argList?.includes('worktree') && argList?.includes('list')) {
          (callback as (e: null, o: string, s: string) => void)(
            null,
            `${worktreePath}  abc1234 [feature/x]\n`,
            '',
          );
          return undefined as never;
        }
        (callback as (e: null, o: string, s: string) => void)(null, '', '');
        return undefined as never;
      },
    );
  });

  afterEach(async () => {
    await rmrfAsync(repoDir);
    await rmrfAsync(stateDir);
  });

  function makeCleanupState(): Record<string, unknown> {
    return makeState({
      phase: 'delegate',
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      worktrees: {
        t1: { branch: 'feature/x', taskId: 't1', status: 'active', path: worktreePath },
      },
      tasks: [],
    });
  }

  it('Compensation_DirtyWorktreeIncludingUntrackedOnly_SkippedAndSurfacedNeverForceRemoved', async () => {
    // The ONLY change is an untracked file the author never `git add`ed — no
    // tracked modification, no staged change, no commit ahead. This is the
    // untracked-only data-loss case the naive `--force` remove would destroy.
    await fs.writeFile(path.join(worktreePath, 'UNSAVED_WORK.txt'), 'precious untracked work\n');
    // Sanity: the untracked-aware probe genuinely sees it as dirty (real git).
    const probe = defaultGitRunner.run(
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath,
    );
    expect(probe.stdout.trim().length).toBeGreaterThan(0);

    const result = await executeCompensation(makeCleanupState(), 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId: 'task010-dirty',
      realpath: identityRealpath,
    });

    // 1. The worktree was NEVER `--force`-removed.
    expect(forceRemoveCalls().length).toBe(0);

    // 2. Skipped-and-surfaced: the action reports the preserved worktree.
    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup).toBeDefined();
    expect(cleanup!.skippedWorktrees).toBeDefined();
    expect(cleanup!.skippedWorktrees!.map((s) => s.worktreePath)).toContain(worktreePath);

    // 3. Nothing was recorded as removed on the unified stream (no vacuous drop):
    // no adopt, no remove pair — the worktree is left intact and still governed
    // by whatever created it.
    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);
    expect(worktreesEvents.some((e) => e.type === 'worktree.remove.executed')).toBe(false);
    expect(worktreesEvents.some((e) => e.type === 'worktree.adopted')).toBe(false);

    // 4. The untracked work still exists on disk — it was preserved.
    expect(fsSync.existsSync(path.join(worktreePath, 'UNSAVED_WORK.txt'))).toBe(true);
  });

  it('Compensation_CleanWorktree_RemovedAsBefore', async () => {
    // No uncommitted work — the worktree is clean, so the dirty-guard passes and
    // the DR-3 unified removal runs exactly as before.
    const probe = defaultGitRunner.run(
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath,
    );
    expect(probe.stdout.trim().length).toBe(0);

    const result = await executeCompensation(makeCleanupState(), 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId: 'task010-clean',
      realpath: identityRealpath,
    });

    // The clean worktree WAS `--force`-removed (removal path reached).
    expect(forceRemoveCalls().length).toBe(1);

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup).toBeDefined();
    expect(cleanup!.status).toBe('executed');
    // No worktree was preserved — nothing to surface.
    expect(cleanup!.skippedWorktrees).toBeUndefined();

    // The unified stream records the completed removal (adopt → requested → executed).
    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);
    const executed = worktreesEvents.filter((e) => e.type === 'worktree.remove.executed');
    expect(executed.length).toBe(1);
    expect((executed[0].data as { removed: boolean }).removed).toBe(true);
  });

  it('Compensation_SkipResult_CarriesScannableReason', async () => {
    // A skipped teardown must carry a stable, scannable reason token so
    // callers / telemetry can branch on WHY the worktree survived — not parse prose.
    await fs.writeFile(path.join(worktreePath, 'untracked.txt'), 'work\n');

    const result = await executeCompensation(makeCleanupState(), 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId: 'task010-reason',
      realpath: identityRealpath,
    });

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup).toBeDefined();

    // Structured, scannable discriminator on the result.
    expect(cleanup!.skippedWorktrees).toEqual([
      { worktreePath, reason: 'dirty-worktree-preserved' },
    ]);

    // The reason token is ALSO surfaced in the human-readable message (so it
    // rides the `compensation:<action>` event metadata telemetry consumes).
    expect(cleanup!.message).toContain('dirty-worktree-preserved');
    expect(cleanup!.message).toContain(worktreePath);
  });
});
