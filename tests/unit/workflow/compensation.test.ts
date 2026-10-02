/**
 * Tests `executeCompensation`. The file mocks only `child_process.execFile`, which the code uses for
 * its async git calls. The rest of the module stays real, so `defaultGitRunner` and the
 * real-worktree setup run actual git. The mock spreads the real module, so `spawnSync` and `spawn`
 * stay defined.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Event } from '../../../src/workflow/types.js';
import { executeCompensation } from '../../../src/workflow/compensation.js';
import { ConcurrencyError } from '../../../src/events/concurrency-error.js';
import { EventStore } from '../../../src/events/store.js';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import * as fsSync from 'node:fs';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { WORKTREES_STREAM, defaultGitRunner } from '../../../src/verbs/worktree/manager.js';
import { createWorktreesReducer } from '../../../src/verbs/worktree/projections/worktrees.js';
import type { RealpathResolver } from '../../../src/verbs/worktree/pure/path-containment.js';
import { canonicalWorktreeId } from '../../../src/verbs/worktree/pure/path-containment.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';

const mockedExecFile = vi.mocked(execFile);

/** Identity resolver — `path.resolve` already normalised the input. */
const identityRealpath: RealpathResolver = (p) => p;

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

describe('B4: delete-feature-branches two-event split', () => {
  /** By default, every git command succeeds. */
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

  /**
   * The first `branch.delete.requested` append throws `ConcurrencyError`. `withStateRetry` retries
   * the append, but `git branch -D` must run at most once.
   */
  it('DeleteFeatureBranches_PhaseARetry_DoesNotRefireGitDeletion', async () => {
    let requestedCallCount = 0;
    const eventStore = makeMockEventStore((streamId, event) => {
      const ev = event as { type?: string };
      if (ev.type === 'branch.delete.requested') {
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

    const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('branch') && args?.includes('-D');
    });
    expect(branchDeleteCalls.length).toBeLessThanOrEqual(1);

    expect(requestedCallCount).toBeGreaterThan(1);
  });

  /**
   * `git rev-parse --verify` fails and `git ls-remote --heads` prints nothing, so the branch is
   * absent. `git branch -D` must not run, `branch.delete.executed` records both flags as `false`,
   * and the action still succeeds.
   */
  it('DeleteFeatureBranches_BranchAlreadyAbsent_RecoversWithoutError', async () => {
    const appendedEvents: Array<{ type: string; data: unknown }> = [];
    const eventStore = makeMockEventStore((_streamId, event) => {
      const ev = event as { type: string; data: unknown };
      appendedEvents.push({ type: ev.type, data: ev.data });
      return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
    });

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        (callback as (err: Error) => void)(new Error('fatal: not a valid object name'));
        return undefined as never;
      }
      if (argList?.includes('ls-remote') && argList?.includes('--heads')) {
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        return undefined as never;
      }
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

    const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('branch') && args?.includes('-D');
    });
    expect(branchDeleteCalls.length).toBe(0);

    const executedEvent = appendedEvents.find((e) => e.type === 'branch.delete.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent!.data as { deletedLocally: boolean; deletedRemote: boolean };
    expect(data.deletedLocally).toBe(false);
    expect(data.deletedRemote).toBe(false);

    const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.status).toBe('executed');
  });

  /**
   * The `branch.delete.executed` append runs after the git side effect. `withStateRetry` must absorb
   * a transient `ConcurrencyError` there. The idempotency key from the `operationId` makes a retry a
   * no-op after the event lands.
   */
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

    expect(executedAppendAttempts).toBeGreaterThanOrEqual(2);
    const deleteAction = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.status).toBe('executed');
  });
});

describe('B5: cleanup-worktrees two-event split', () => {
  /** By default, every git command succeeds. */
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

  /**
   * `git worktree list` reports the worktree. The first `worktree.remove.requested` append throws
   * `ConcurrencyError`. The append is retried, but `git worktree remove` must run at most once.
   */
  it('CleanupWorktrees_PhaseARetry_DoesNotRefireGitWorktreeRemove', async () => {
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

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          '/tmp/wt-b5-test  abc1234 [feature/b5-test]\n',
          '',
        );
        return undefined as never;
      }
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

    const worktreeRemoveCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('worktree') && args?.includes('remove');
    });
    expect(worktreeRemoveCalls.length).toBeLessThanOrEqual(1);

    expect(requestedCallCount).toBeGreaterThan(1);
  });

  /**
   * `git worktree list` does not hold the worktree. `git worktree remove` must not run,
   * `worktree.remove.executed` records `removed: false`, and the action still succeeds.
   */
  it('CleanupWorktrees_WorktreeAlreadyAbsent_RecoversWithoutError', async () => {
    const appendedEvents: Array<{ type: string; data: unknown }> = [];
    const eventStore = makeMockEventStore((_streamId, event) => {
      const ev = event as { type: string; data: unknown };
      appendedEvents.push({ type: ev.type, data: ev.data });
      return Promise.resolve({ sequence: appendedEvents.length, type: ev.type });
    });

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
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

    const worktreeRemoveCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('worktree') && args?.includes('remove');
    });
    expect(worktreeRemoveCalls.length).toBe(0);

    const executedEvent = appendedEvents.find((e) => e.type === 'worktree.remove.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent!.data as { removed: boolean };
    expect(data.removed).toBe(false);

    const cleanupAction = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanupAction).toBeDefined();
    expect(cleanupAction!.status).toBe('executed');
  });
});

/**
 * With a real SQLite `EventStore`, each branch gets `branch.delete.requested` and then
 * `branch.delete.executed`. Both events carry the same `operationId` and branch name.
 */
describe('B4.5: delete-feature-branches parity harness (two-event sequence)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-b4-parity-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('rev-parse') && argList?.includes('--verify')) {
        (callback as (err: null, stdout: string, stderr: string) => void)(null, 'abc1234', '');
        return undefined as never;
      }
      if (argList?.includes('ls-remote') && argList?.includes('--heads')) {
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          'abc1234\trefs/heads/feature/parity-branch\n',
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

  /** Git reports the branch locally and remotely, so `branch.delete.executed` records both flags as `true`. */
  it('DeleteFeatureBranches_Parity_BothCarriersObserveTwoEventSequence', async () => {
    const featureId = 'b4-parity-feature';
    const branchName = 'feature/parity-branch';

    const state = makeState({
      phase: 'delegate',
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [{ id: 't1', title: 'T1', status: 'complete', branch: branchName }],
    });

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
    });

    const events = await eventStore.query(featureId);

    const requestedEvents = events.filter((e) => e.type === 'branch.delete.requested');
    const executedEvents = events.filter((e) => e.type === 'branch.delete.executed');

    expect(requestedEvents.length).toBe(1);
    expect(executedEvents.length).toBe(1);

    const requestedSeq = requestedEvents[0].sequence;
    const executedSeq = executedEvents[0].sequence;
    expect(requestedSeq).toBeLessThan(executedSeq);

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

    expect(exeData.deletedLocally).toBe(true);
    expect(exeData.deletedRemote).toBe(true);
  });
});

describe('B5.5: cleanup-worktrees parity harness (two-event sequence)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-b5-parity-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];

      if (argList?.includes('worktree') && argList?.includes('list')) {
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

  /**
   * The remove pair must land on the singleton `worktrees` stream, not the `featureId` stream. Both
   * events carry the same `operationId` and path, and the executed event records `removed: true`.
   */
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

    await executeCompensation(state, 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId,
      realpath: identityRealpath,
    });

    const events = await eventStore.query('worktrees');

    const requestedEvents = events.filter((e) => e.type === 'worktree.remove.requested');
    const executedEvents = events.filter((e) => e.type === 'worktree.remove.executed');

    expect(requestedEvents.length).toBe(1);
    expect(executedEvents.length).toBe(1);

    const featureStream = await eventStore.query(featureId);
    expect(featureStream.some((e) => e.type === 'worktree.remove.requested')).toBe(false);
    expect(featureStream.some((e) => e.type === 'worktree.remove.executed')).toBe(false);

    const requestedSeq = requestedEvents[0].sequence;
    const executedSeq = executedEvents[0].sequence;
    expect(requestedSeq).toBeLessThan(executedSeq);

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

    expect(exeData.removed).toBe(true);
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A mock store whose `query` returns the seeded events that match its `type` filter, like the real
 * backend. The recovery scanners query `*.requested` and `*.executed`. A seed of only the requested
 * type gives an unmatched request, and the handler must reuse its `operationId`.
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

/**
 * When compensation crashes between `*.requested` and `*.executed`, the retry must reuse the
 * orphaned `operationId`. A fresh id orphans the first request and breaks the one-to-one pairing.
 * The recovery functions scan the stream for the most recent unmatched `*.requested`.
 */
describe('#1352: compensation operationId recovery (reuse vs mint)', () => {
  /** Every git call succeeds, and the presence checks report the worktree and the branch. */
  beforeEach(() => {
    vi.clearAllMocks();
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
        (callback as (err: null, stdout: string, stderr: string) => void)(null, 'abc1234', '');
        return undefined as never;
      }
      if (argList?.includes('ls-remote') && argList?.includes('--heads')) {
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

  /**
   * The seed holds an orphaned `worktree.remove.requested` for this worktree. The new requested
   * event and its executed event must both reuse that `operationId`.
   */
  it('Compensation_RecoveryWithUnmatchedRequested_ReusesOperationId (cleanup-worktrees)', async () => {
    const worktreePath = '/tmp/wt-recover';
    const priorOperationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const appendedEvents: Array<{ type: string; data: { operationId: string } }> = [];
    const eventStore = makeTypeAwareMockEventStore(
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

    expect(requested!.data.operationId).toBe(priorOperationId);
    expect(executed!.data.operationId).toBe(priorOperationId);

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup!.status).toBe('executed');
  });

  /** Without a prior request, the recovery finds nothing and the handler mints a fresh UUID. */
  it('Compensation_NoPriorRequested_MintsFreshId (cleanup-worktrees)', async () => {
    const worktreePath = '/tmp/wt-recover';

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
    expect(requested!.data.operationId).toMatch(UUID_RE);
  });

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

  /**
   * The prior request already has an executed event with the same `operationId`, so the operation
   * is complete. The scanner must not reuse that id, and the handler mints a fresh one.
   */
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
    expect(requested!.data.operationId).not.toBe(completedOperationId);
    expect(requested!.data.operationId).toMatch(UUID_RE);
  });
});

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

  /** A failed `gh pr close` gives a `failed` action whose message holds the error. */
  it('ClosePR_GhCommandFails_ReturnsFailed', async () => {
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

  /** When `gh pr close` fails with a value that is not an `Error`, the message uses `String(err)`. */
  it('ClosePR_NonErrorThrown_StringifiesMessage', async () => {
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

    mockedExecFile.mockImplementation((cmd: unknown, args: unknown, opts: unknown, cb?: unknown) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const argList = args as string[];
      if (cmd === 'gh' && argList?.includes('close')) {
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
    expect(closePrAction!.message).toContain('Failed to close PR');
    expect(closePrAction!.message).toContain('42');
  });
});

/**
 * The existence checks `localBranchExists`, `remoteBranchExists` and `worktreeIsRegistered` map a
 * benign non-zero exit to "absent", so recovery stays idempotent. An operational failure, such as
 * a timeout or a missing repository, propagates, and the action reports `failed`.
 */
describe('compensation: operational git failures surface (CodeRabbit #3224631272)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A timeout kills `git rev-parse --verify`, and the error carries `killed: true`. That error
   * must not count as an absent branch, so the action fails and `git branch -D` does not run.
   */
  it('DeleteFeatureBranches_GitRevParseTimesOut_ActionFails', async () => {
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

    const action = result.actions.find((a) => a.actionId === 'delegate:delete-feature-branches');
    expect(action).toBeDefined();
    expect(action!.status).toBe('failed');

    const branchDeleteCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('branch') && args?.includes('-D');
    });
    expect(branchDeleteCalls.length).toBe(0);
  });

  /** `git worktree list` runs outside a repository, and stderr holds "not a git repository". The action must fail. */
  it('CleanupWorktrees_GitNotARepository_ActionFails', async () => {
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

    const removeCalls = mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return args?.includes('worktree') && args?.includes('remove');
    });
    expect(removeCalls.length).toBe(0);
  });

  /**
   * `git rev-parse --verify` exits 128 with "Not a valid object name", the benign miss of an absent
   * branch. The action must still succeed and append `branch.delete.executed`.
   */
  it('DeleteFeatureBranches_BranchAbsentExitCode_StillRecoversCleanly', async () => {
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

    const executedEvent = appendedEvents.find((e) => e.type === 'branch.delete.executed');
    expect(executedEvent).toBeDefined();
  });
});

/**
 * Compensation appends the `worktree.remove.*` pair to the singleton `worktrees` stream, so the
 * `worktrees` view drops a removed worktree. The tests use a real SQLite `EventStore`. They cover
 * the adopt step, a resume after a crash, and the `index.lock` retry of `git worktree remove`.
 *
 * `stubWorktreeRegistered` makes `git worktree list` report the given path, or no path for `null`.
 * Every other git call succeeds.
 */
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

  /**
   * The worktree has no entry, so compensation appends `worktree.adopted` and then the remove pair,
   * all on the `worktrees` stream. The drop is not vacuous: a fold before the executed event still
   * holds the entry.
   */
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

    const adopted = worktreesEvents.filter((e) => e.type === 'worktree.adopted');
    const requested = worktreesEvents.filter((e) => e.type === 'worktree.remove.requested');
    const executed = worktreesEvents.filter((e) => e.type === 'worktree.remove.executed');
    expect(adopted.length).toBe(1);
    expect(requested.length).toBe(1);
    expect(executed.length).toBe(1);
    expect((adopted[0].data as { worktreeId: string }).worktreeId).toBe(worktreeId);

    expect(adopted[0].sequence).toBeLessThan(requested[0].sequence);
    expect(requested[0].sequence).toBeLessThan(executed[0].sequence);

    const featureEvents = await eventStore.query(featureId);
    expect(featureEvents.some((e) => e.type.startsWith('worktree.'))).toBe(false);

    const beforeTerminal = foldWorktrees(
      worktreesEvents.filter((e) => e.type !== 'worktree.remove.executed'),
    );
    expect(beforeTerminal.worktrees[worktreeId]).toBeDefined();
    const finalView = foldWorktrees(worktreesEvents);
    expect(worktreeId in finalView.worktrees).toBe(false);
  });

  /**
   * The seed is a crash on the `worktrees` stream: adopted and requested, but no executed. The seed
   * uses the production idempotency keys, so the resume reuses the request and skips the adopt.
   * The stream then holds one event of each type.
   */
  it('Compensation_CrashBetweenRequestedAndExecuted_ResumesIdempotently', async () => {
    const featureId = 'task009-crash-feature';
    const worktreePath = '/tmp/wt-crash-resume';
    const worktreeId = canonicalWorktreeId(worktreePath, identityRealpath);
    const crashedOperationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    stubWorktreeRegistered(worktreePath);

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

    expect(requested.length).toBe(1);
    expect(executed.length).toBe(1);
    expect(adopted.length).toBe(1);
    expect((requested[0].data as { operationId: string }).operationId).toBe(crashedOperationId);
    expect((executed[0].data as { operationId: string; removed: boolean }).operationId).toBe(
      crashedOperationId,
    );
    expect((executed[0].data as { removed: boolean }).removed).toBe(true);

    expect(worktreeId in foldWorktrees(worktreesEvents).worktrees).toBe(false);
  });

  /**
   * The seed is an older crash: `worktree.remove.requested` sits only on the `featureId` stream.
   * The resume adopts the worktree and completes the pair on `worktrees` under the original
   * `operationId`. The `featureId` stream keeps its orphaned request and gets no executed event.
   */
  it('Compensation_PreDeployCrashLegacyFeatureStreamRequested_ResumedUnderOriginalOperationId', async () => {
    const featureId = 'task009-legacy-feature';
    const worktreePath = '/tmp/wt-legacy-resume';
    const worktreeId = canonicalWorktreeId(worktreePath, identityRealpath);
    const legacyOperationId = 'bbbbbbbb-5555-6666-7777-888888888888';
    stubWorktreeRegistered(worktreePath);

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

    expect(adopted.length).toBe(1);
    expect(requested.length).toBe(1);
    expect(executed.length).toBe(1);
    expect((requested[0].data as { operationId: string }).operationId).toBe(legacyOperationId);
    expect((executed[0].data as { operationId: string }).operationId).toBe(legacyOperationId);

    const featureEvents = await eventStore.query(featureId);
    expect(featureEvents.filter((e) => e.type === 'worktree.remove.requested').length).toBe(1);
    expect(featureEvents.some((e) => e.type === 'worktree.remove.executed')).toBe(false);

    expect(worktreeId in foldWorktrees(worktreesEvents).worktrees).toBe(false);
  });

  /**
   * The first `git worktree remove` fails on `index.lock`, and the second succeeds. `git worktree
   * list` always reports the worktree, so a missing retry fails the action. A no-op sleep and zero
   * jitter make the retry instant.
   */
  it('Compensation_WorktreeRemove_IndexLockContention_RetriesRemove (DR-1)', async () => {
    const featureId = 'task009-lock-feature';
    const worktreePath = '/tmp/wt-lock-retry';

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
      indexLockRetry: { sleep: async () => {}, jitter: () => 0 },
    });

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

/**
 * Cancel teardown must never force-remove a worktree with uncommitted work, untracked-only files
 * included. A dirty worktree is skipped and reported with a stable reason. A clean worktree is
 * removed. Each test uses a real git repository and worktree, and `defaultGitRunner` runs the dirty
 * probe with real git. The `execFile` calls stay mocked, so the removal does not change the real
 * repository. `forceRemoveCalls` lists the mocked `git worktree remove --force` calls.
 */
describe('Task 010: teardown dirty-guard (INV-14 / DR-3)', () => {
  let repoDir: string;
  let worktreePath: string;
  let stateDir: string;
  let eventStore: EventStore;

  async function git(cwd: string, args: readonly string[]): Promise<string> {
    return (await execFileAsync('git', args, { cwd })).trim();
  }

  function forceRemoveCalls(): unknown[][] {
    return mockedExecFile.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return (
        args?.includes('worktree') && args?.includes('remove') && args?.includes('--force')
      );
    });
  }

  /**
   * The setup makes a repository with one commit and a worktree on `feature/x`. The `execFile` mock
   * reports the worktree as registered and lets every other call succeed.
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-task010-'));
    await git(repoDir, ['init', '-q', '-b', 'work']);
    await git(repoDir, ['config', 'user.email', 'task010@example.com']);
    await git(repoDir, ['config', 'user.name', 'Task010 Test']);
    await git(repoDir, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# dirty-guard test\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-q', '-m', 'init']);

    worktreePath = path.join(repoDir, 'wt');
    await git(repoDir, ['worktree', 'add', '-q', worktreePath, '-b', 'feature/x']);

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-task010-state-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();

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

  /**
   * The only change is an untracked file. The worktree must not be force-removed, and the action
   * must list it in `skippedWorktrees`. The stream gets no adopt and no executed event, and the file
   * stays on disk.
   */
  it('Compensation_DirtyWorktreeIncludingUntrackedOnly_SkippedAndSurfacedNeverForceRemoved', async () => {
    await fs.writeFile(path.join(worktreePath, 'UNSAVED_WORK.txt'), 'precious untracked work\n');
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

    expect(forceRemoveCalls().length).toBe(0);

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup).toBeDefined();
    expect(cleanup!.skippedWorktrees).toBeDefined();
    expect(cleanup!.skippedWorktrees!.map((s) => s.worktreePath)).toContain(worktreePath);

    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);
    expect(worktreesEvents.some((e) => e.type === 'worktree.remove.executed')).toBe(false);
    expect(worktreesEvents.some((e) => e.type === 'worktree.adopted')).toBe(false);

    expect(fsSync.existsSync(path.join(worktreePath, 'UNSAVED_WORK.txt'))).toBe(true);
  });

  /** A clean worktree passes the dirty check and is removed. The action reports no skipped worktree. */
  it('Compensation_CleanWorktree_RemovedAsBefore', async () => {
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

    expect(forceRemoveCalls().length).toBe(1);

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup).toBeDefined();
    expect(cleanup!.status).toBe('executed');
    expect(cleanup!.skippedWorktrees).toBeUndefined();

    const worktreesEvents = await eventStore.query(WORKTREES_STREAM);
    const executed = worktreesEvents.filter((e) => e.type === 'worktree.remove.executed');
    expect(executed.length).toBe(1);
    expect((executed[0].data as { removed: boolean }).removed).toBe(true);
  });

  /**
   * A skipped teardown carries the stable reason `dirty-worktree-preserved`, so a caller can branch
   * on it without a prose parse. The message holds the reason too, for the event metadata.
   */
  it('Compensation_SkipResult_CarriesScannableReason', async () => {
    await fs.writeFile(path.join(worktreePath, 'untracked.txt'), 'work\n');

    const result = await executeCompensation(makeCleanupState(), 'delegate', makeEvents(1), 1, {
      dryRun: false,
      eventStore,
      featureId: 'task010-reason',
      realpath: identityRealpath,
    });

    const cleanup = result.actions.find((a) => a.actionId === 'delegate:cleanup-worktrees');
    expect(cleanup).toBeDefined();

    expect(cleanup!.skippedWorktrees).toEqual([
      { worktreePath, reason: 'dirty-worktree-preserved' },
    ]);

    expect(cleanup!.message).toContain('dirty-worktree-preserved');
    expect(cleanup!.message).toContain(worktreePath);
  });
});
