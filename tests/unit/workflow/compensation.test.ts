/**
 * Tests the ledger-only `executeCompensation` against a real event store.
 *
 * Each process start of `child_process` fails and counts, so a test proves that the cancel starts no process.
 * The cases cover the outstanding record of each resource and a resource that is already absent.
 * They also cover a prior failed removal, the replay result, and the worktree reservations that a cancel keeps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const processStarts = vi.hoisted(() => ({ count: 0 }));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const refuse = (): never => {
    processStarts.count += 1;
    throw new Error('the ledger-only cancel started a process');
  };
  return {
    ...actual,
    exec: vi.fn(refuse),
    execFile: vi.fn(refuse),
    execFileSync: vi.fn(refuse),
    execSync: vi.fn(refuse),
    fork: vi.fn(refuse),
    spawn: vi.fn(refuse),
    spawnSync: vi.fn(refuse),
  };
});

import { executeCompensation, type CompensationOptions } from '../../../src/workflow/compensation.js';
import { acquireCancelOwnership } from '../../../src/workflow/cancel-process-manager.js';
import { EventStore } from '../../../src/events/store.js';
import { WORKTREES_STREAM } from '../../../src/verbs/worktree/manager.js';
import { createWorktreesReducer } from '../../../src/verbs/worktree/projections/worktrees.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** The phase attempt id of the cancel in each process-managed case. */
const PHASE_ATTEMPT_ID = `phase-attempt:${'ab'.repeat(32)}`;

/** The cancel id of the cancel in each process-managed case. */
const CANCEL_ID = `cancel:${PHASE_ATTEMPT_ID}`;

/** The feature id of each case. Each case has its own store. */
const FEATURE_ID = 'compensation-ledger';

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  processStarts.count = 0;
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compensation-ledger-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** Builds a synthesize state that names one resource of each kind. The worktree path does not exist on disk. */
function stateWithEachResource(): Record<string, unknown> {
  return {
    featureId: FEATURE_ID,
    workflowType: 'feature',
    phase: 'synthesize',
    synthesis: {
      integrationBranch: 'integrate/absent',
      mergeOrder: [],
      mergedBranches: [],
      prUrl: 'https://example.invalid/pull/9',
      prFeedback: [],
    },
    worktrees: {
      one: { branch: 'task/one', taskId: 'one', status: 'active', path: path.join(os.tmpdir(), `absent-${randomUUID()}`) },
      bare: { branch: 'task/bare', taskId: 'bare', status: 'active' },
    },
    tasks: [
      { id: 'one', title: 'One', status: 'complete', branch: 'task/one' },
      { id: 'two', title: 'Two', status: 'complete' },
    ],
  };
}

/** Returns the worktree path of {@link stateWithEachResource}. */
function worktreePathOf(state: Record<string, unknown>): string {
  const worktrees = state.worktrees;
  if (typeof worktrees !== 'object' || worktrees === null) throw new Error('the state has no worktrees');
  const one: unknown = Reflect.get(worktrees, 'one');
  const worktreePath: unknown = typeof one === 'object' && one !== null ? Reflect.get(one, 'path') : undefined;
  if (typeof worktreePath !== 'string') throw new Error('the worktree has no path');
  return worktreePath;
}

/** Takes cancel ownership and returns the options of the process-managed path. */
async function processManagedOptions(): Promise<CompensationOptions> {
  const owned = await acquireCancelOwnership(store, {
    featureId: FEATURE_ID,
    cancelId: CANCEL_ID,
    phaseAttemptId: PHASE_ATTEMPT_ID,
    instanceId: `instance-${randomUUID()}`,
    operationId: `ownership-${randomUUID()}`,
  });
  return {
    dryRun: false,
    eventStore: store,
    featureId: FEATURE_ID,
    cancelProcess: {
      cancelId: CANCEL_ID,
      phaseAttemptId: PHASE_ATTEMPT_ID,
      writerEpoch: owned.epoch,
      instanceId: `instance-${owned.epoch}`,
    },
  };
}

/** Returns the rows of one stream whose type starts with one of the prefixes. */
async function rowsWithPrefix(streamId: string, prefixes: readonly string[]): Promise<WorkflowEvent[]> {
  return (await store.query(streamId)).filter((row) => prefixes.some((prefix) => row.type.startsWith(prefix)));
}

/** Runs a synthesize compensation with each resource and checks that it records each one and starts no process. */
async function expectEachResourceRecorded(options: CompensationOptions): Promise<void> {
  const state = stateWithEachResource();

  const result = await executeCompensation(state, 'synthesize', [], 0, options);

  expect(processStarts.count).toBe(0);
  expect(result.success).toBe(true);
  expect(result.actions).toEqual([
    {
      actionId: 'synthesize:close-pr',
      status: 'outstanding',
      message: 'Recorded PR as outstanding: https://example.invalid/pull/9',
      resources: [{ kind: 'pull-request', ref: 'https://example.invalid/pull/9', status: 'outstanding' }],
    },
    {
      actionId: 'delegate:delete-integration-branch',
      status: 'outstanding',
      message: 'Recorded integration branch as outstanding: integrate/absent',
      resources: [{ kind: 'integration-branch', ref: 'integrate/absent', status: 'outstanding' }],
    },
    {
      actionId: 'delegate:cleanup-worktrees',
      status: 'outstanding',
      message: `Recorded 1 worktree(s) as outstanding: ${worktreePathOf(state)}`,
      resources: [{ kind: 'worktree', ref: worktreePathOf(state), status: 'outstanding' }],
    },
    {
      actionId: 'delegate:delete-feature-branches',
      status: 'outstanding',
      message: 'Recorded 1 feature branch(es) as outstanding: task/one',
      resources: [{ kind: 'feature-branch', ref: 'task/one', status: 'outstanding' }],
    },
  ]);
}

describe('ledger-only compensation', () => {
  /** The checkpoint path records each resource and starts no process. */
  it('Compensation_EachResource_RecordedOutstandingWithNoProcess (checkpoint)', async () => {
    await expectEachResourceRecorded({ dryRun: false });
  });

  /** The process-managed path records each resource and starts no process. */
  it('Compensation_EachResource_RecordedOutstandingWithNoProcess (process-managed)', async () => {
    await expectEachResourceRecorded(await processManagedOptions());
  });

  /**
   * The worktree path does not exist and the branches exist nowhere. A probe reads such resources as removed.
   * The ledger-only cancel does not probe, so each resource stays outstanding and is never a completion.
   */
  it('Compensation_AbsentWorktreeAndBranch_StayOutstanding', async () => {
    const state = stateWithEachResource();
    await expect(fs.access(worktreePathOf(state))).rejects.toThrow();

    const result = await executeCompensation(state, 'delegate', [], 0, await processManagedOptions());

    expect(result.actions.map((action) => action.status)).toEqual(['outstanding', 'outstanding', 'outstanding']);
    const completed = await rowsWithPrefix(FEATURE_ID, ['cancel.compensation-completed']);
    expect(completed.map((row) => row.data?.status)).toEqual(['outstanding', 'outstanding', 'outstanding']);
    expect(completed.some((row) => row.data?.status === 'executed')).toBe(false);
  });

  /** An earlier attempt of this cancel recorded a failed removal. The ledger-only attempt keeps the failure. */
  it('Compensation_PriorFailedRemoval_StaysAFailure', async () => {
    await store.append(FEATURE_ID, {
      type: 'cancel.compensation-failed',
      data: {
        eventVersion: '1.0',
        cancelId: CANCEL_ID,
        featureId: FEATURE_ID,
        phaseAttemptId: PHASE_ATTEMPT_ID,
        actionId: 'delegate:delete-feature-branches',
        reason: 'effect-failed',
        message: 'branch delete failed',
        failedAt: new Date().toISOString(),
      },
    });

    const result = await executeCompensation(stateWithEachResource(), 'delegate', [], 0, await processManagedOptions());

    expect(processStarts.count).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('COMPENSATION_PARTIAL');
    expect(result.durableOutcomes?.completedActionIds).toEqual([
      'delegate:delete-integration-branch',
      'delegate:cleanup-worktrees',
    ]);
    const failures = await rowsWithPrefix(FEATURE_ID, ['cancel.compensation-failed']);
    expect(failures.length).toBeGreaterThan(1);
    for (const failure of failures.slice(1)) {
      expect(failure.data).toMatchObject({
        actionId: 'delegate:delete-feature-branches',
        reason: 'effect-failed',
        message: 'A prior removal failed, and the cancel keeps the failure: branch delete failed',
      });
    }
    expect((await rowsWithPrefix(FEATURE_ID, ['cancel.compensation-completed'])).map((row) => row.data?.actionId)).toEqual([
      'delegate:delete-integration-branch',
      'delegate:cleanup-worktrees',
    ]);
  });

  /** A failed result built from a malformed outcome is not a failed removal, so a retry records the resource. */
  it('Compensation_MalformedPriorOutcome_IsNotAFailedRemoval', async () => {
    await store.append(FEATURE_ID, {
      type: 'cancel.compensation-failed',
      data: {
        eventVersion: '1.0',
        cancelId: CANCEL_ID,
        featureId: FEATURE_ID,
        phaseAttemptId: PHASE_ATTEMPT_ID,
        actionId: 'delegate:delete-integration-branch',
        reason: 'malformed-result',
        message: 'Malformed compensation result',
        failedAt: new Date().toISOString(),
      },
    });

    const result = await executeCompensation(stateWithEachResource(), 'delegate', [], 0, await processManagedOptions());

    expect(result.success).toBe(true);
    expect(result.actions[0]).toMatchObject({ actionId: 'delegate:delete-integration-branch', status: 'outstanding' });
  });

  /** The call that records an action returns its status. A later call of the same cancel returns the replay result. */
  it('Compensation_ProcessManaged_FreshRunReportsStatusAndReplayKeepsItsResult', async () => {
    const state = stateWithEachResource();
    const first = await executeCompensation(state, 'delegate', [], 0, await processManagedOptions());
    const second = await executeCompensation(state, 'delegate', [], 0, await processManagedOptions());

    expect(first.actions.map((action) => action.status)).toEqual(['outstanding', 'outstanding', 'outstanding']);
    expect(second.actions).toEqual([
      { actionId: 'delegate:delete-integration-branch', status: 'skipped', message: 'Already completed (event replay)' },
      { actionId: 'delegate:cleanup-worktrees', status: 'skipped', message: 'Already completed (event replay)' },
      { actionId: 'delegate:delete-feature-branches', status: 'skipped', message: 'Already completed (event replay)' },
    ]);
    expect(second.success).toBe(true);
    expect(await rowsWithPrefix(FEATURE_ID, ['cancel.compensation-completed'])).toHaveLength(3);
  });

  /** The process-managed result carries one `workflow.compensation` record for each action, for the cancel trail. */
  it('Compensation_ProcessManaged_ReturnsOneLedgerRecordPerAction', async () => {
    const result = await executeCompensation(stateWithEachResource(), 'delegate', [], 0, await processManagedOptions());

    expect(result.events.map((event) => event.type)).toEqual(['compensation', 'compensation', 'compensation']);
    expect(result.events.map((event) => event.trigger)).toEqual([
      'compensation:delegate:delete-integration-branch',
      'compensation:delegate:cleanup-worktrees',
      'compensation:delegate:delete-feature-branches',
    ]);
    expect(result.events[2]?.metadata).toEqual({
      actionId: 'delegate:delete-feature-branches',
      status: 'outstanding',
      message: 'Recorded 1 feature branch(es) as outstanding: task/one',
      resources: [{ kind: 'feature-branch', ref: 'task/one', status: 'outstanding' }],
    });
  });

  /**
   * The cancel appends no worktree or branch removal row, and it does not touch the `worktrees` stream.
   * A reservation stays outstanding, so only `release_worktree` or `reconcile_worktrees` clears it.
   */
  it('Compensation_WorktreeReservation_StaysOutstanding', async () => {
    const state = stateWithEachResource();
    const worktreePath = worktreePathOf(state);
    await store.append(WORKTREES_STREAM, {
      type: 'worktree.reserved',
      data: {
        worktreeId: worktreePath,
        path: worktreePath,
        featureId: FEATURE_ID,
        operationId: randomUUID(),
        ownerPid: 4242,
        ownerStartedAt: null,
      },
    });

    const result = await executeCompensation(state, 'synthesize', [], 0, await processManagedOptions());

    expect(result.success).toBe(true);
    const worktreeRows = await store.query(WORKTREES_STREAM);
    expect(worktreeRows.map((row) => row.type)).toEqual(['worktree.reserved']);
    const reducer = createWorktreesReducer((value) => value);
    const projection = worktreeRows.reduce((acc, row) => reducer.apply(acc, row), reducer.initial);
    expect(projection.worktrees[worktreePath]).toMatchObject({ featureId: FEATURE_ID });
    expect(await rowsWithPrefix(FEATURE_ID, ['branch.delete.', 'worktree.'])).toHaveLength(0);
  });

  /** A dry run lists each resource that a real cancel records, and writes nothing. */
  it('Compensation_DryRun_ListsTheResourcesAndWritesNothing', async () => {
    const state = stateWithEachResource();
    const result = await executeCompensation(state, 'delegate', [], 0, { dryRun: true });

    expect(processStarts.count).toBe(0);
    expect(result.actions.map((action) => [action.status, action.message])).toEqual([
      ['dry-run', 'Would record integration branch as outstanding: integrate/absent'],
      ['dry-run', `Would record 1 worktree(s) as outstanding: ${worktreePathOf(state)}`],
      ['dry-run', 'Would record 1 feature branch(es) as outstanding: task/one'],
    ]);
    expect(await store.query(FEATURE_ID)).toHaveLength(0);
  });

  /** The ledger needs a stream ID, so an event store without a feature ID fails before any record. */
  it('Compensation_EventStoreWithoutFeatureId_Throws', async () => {
    await expect(
      executeCompensation(stateWithEachResource(), 'delegate', [], 0, { dryRun: false, eventStore: store }),
    ).rejects.toThrow(/without options\.featureId/);
  });
});
