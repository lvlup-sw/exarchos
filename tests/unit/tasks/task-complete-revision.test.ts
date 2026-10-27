/**
 * Tests for the revision check of `task_complete`. A design revision after the capsule of a task that names the task
 * refuses the completion, and the handler appends no row. The capsule is the prepared record of `capsuleVersion`, or
 * the latest prepared record of the stream when the call gives no version.
 *
 * Each case uses the real SQLite event store and a passing static-analysis run from the shared seed. A case that
 * expects a completion also holds a refusal on the same stream, so the case fails when the check is absent.
 *
 * @oracle-sources: ../../../src/verbs/tasks/tools.ts, the rows that each case appends and the order of them
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventStore, SequenceConflictError } from '../../../src/events/store.js';
import { DesignRevisedData, WorkflowPreparedData, type WorkflowEvent } from '../../../src/events/schemas.js';
import { latestPreparedRecordOf } from '../../../src/verbs/prepare/prepared-record.js';
import { handleTaskComplete, handleTaskFail, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { seedStaticAnalysisVerdict } from '../../helpers/static-analysis-verdict.js';

const STREAM = 'feat-task-complete-revision';
const TASK = 'task-revised';
const OTHER_TASK = 'task-other';
/**
 * The tree that each completion names and each seed stamps. The path does not exist and is outside git, so its stamp
 * keeps its text on every platform and carries no commit.
 */
const WORKTREE = '/nonexistent-task-complete-revision-worktree';
const BUNDLE_REF = {
  artifactId: `run-bundle:settlement:${STREAM}:1`,
  digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
};

let tempDir: string;
let store: EventStore;

beforeEach(() => {
  resetModuleEventStore();
  tempDir = makeTempDir('task-complete-revision-');
  store = new EventStore(tempDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetModuleEventStore();
  await rmrfAsync(tempDir);
});

/** The data of the prepared record of one capsule version. The digest tells two records of one version apart. */
function preparedData(capsuleVersion: number, capsuleDigest = `digest-v${capsuleVersion}`): Record<string, unknown> {
  return WorkflowPreparedData.parse({
    operationId: `prepare:${capsuleDigest}`,
    workflowId: STREAM,
    workflowType: 'feature',
    capsuleVersion,
    definitionVersion: 'definition-1',
    designVersion: `design-v${capsuleVersion}`,
    capsuleDigest,
    compilerVersion: 'compiler-1',
    taskCount: 2,
    requestDigest: `request:${capsuleDigest}`,
    bundleRefs: [BUNDLE_REF],
  });
}

/** The data of a revision row that names the tasks and moves the design to `nextDesignVersion`. */
function revisionData(nextDesignVersion: number, affectedTasks: readonly string[]): Record<string, unknown> {
  return DesignRevisedData.parse({
    operationId: `settle:batch-${nextDesignVersion}`,
    workflowId: STREAM,
    capsuleVersion: 1,
    batchId: `batch-${nextDesignVersion}`,
    priorDesignVersion: nextDesignVersion - 1,
    nextDesignVersion,
    deviationIds: [`deviation-${nextDesignVersion}`],
    affectedTasks: [...affectedTasks],
    bundleRefs: [BUNDLE_REF],
  });
}

/** Appends the prepared record of one capsule version. */
async function prepare(capsuleVersion: number): Promise<WorkflowEvent> {
  return store.append(STREAM, { type: 'workflow.prepared', data: preparedData(capsuleVersion) });
}

/** Appends a revision row that names the tasks. */
async function revise(nextDesignVersion: number, affectedTasks: readonly string[]): Promise<WorkflowEvent> {
  return store.append(STREAM, { type: 'design.revised', data: revisionData(nextDesignVersion, affectedTasks) });
}

/** Seeds a static-analysis run of the task on the tree of the test. The run passes unless the call names a fail. */
async function gate(taskId: string, verdict: 'pass' | 'fail' = 'pass'): Promise<void> {
  await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId, stateDir: tempDir, verdict, worktreePath: WORKTREE });
}

/**
 * Calls `task_complete` for the task on the stream of the test, with the capsule version when the call gives one.
 * The completion names the tree of the test, because a prepared stream refuses a completion that names no tree.
 */
function complete(taskId: string, capsuleVersion?: number): ReturnType<typeof handleTaskComplete> {
  const result = { worktreePath: WORKTREE };
  return handleTaskComplete(
    capsuleVersion === undefined
      ? { taskId, streamId: STREAM, result }
      : { taskId, streamId: STREAM, result, capsuleVersion },
    tempDir,
    store,
  );
}

/** The `task.completed` rows of the task. */
async function completionRows(taskId: string): Promise<readonly WorkflowEvent[]> {
  const rows = await store.query(STREAM, { type: 'task.completed' });
  return rows.filter((row) => row.idempotencyKey === `${STREAM}:task.completed:${taskId}`);
}

describe('task_complete refuses a task that a revision names after its capsule', () => {
  /** The revision moves the design to version 2, so the refusal names `design-v2` and the capsule v1. */
  it('TaskComplete_ATaskARevisionNamedAfterItsCapsule_IsRefusedWithNoRow', async () => {
    await prepare(1);
    await revise(2, [TASK]);
    await gate(TASK);

    const result = await complete(TASK, 1);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TASK_SUPERSEDED_BY_REVISION');
    expect(result.error?.message).toContain(`Task '${TASK}' compiled in capsule v1`);
    expect(result.error?.message).toContain('design-v2');
    expect(result.error?.message).toContain('Run prepare again, then complete the task under the new capsule.');
    expect(await completionRows(TASK)).toHaveLength(0);
  });

  /** The revision comes after capsule v1 and before capsule v2. Thus capsule v1 refuses and capsule v2 completes. */
  it('TaskComplete_ATaskRevisedBeforeItsCapsule_Completes', async () => {
    await prepare(1);
    await revise(2, [TASK]);
    await prepare(2);
    await gate(TASK);

    const refused = await complete(TASK, 1);
    expect(refused.error?.code).toBe('TASK_SUPERSEDED_BY_REVISION');

    const completed = await complete(TASK, 2);

    expect(completed.success, JSON.stringify(completed.error)).toBe(true);
    const [row] = await completionRows(TASK);
    expect(completed.data).toEqual({ streamId: STREAM, sequence: row?.sequence, type: 'task.completed' });
  });

  /**
   * Before the continuation prepare, the latest record is capsule v1, so the call refuses. The refusal names that
   * record as the latest prepared capsule, not as the capsule of the task. After the prepare, the call completes.
   */
  it('TaskComplete_WithNoCapsuleVersion_ATaskRecompiledAfterItsRevision_Completes', async () => {
    await prepare(1);
    await revise(2, [TASK]);
    await gate(TASK);

    const refused = await complete(TASK);
    expect(refused.error?.code).toBe('TASK_SUPERSEDED_BY_REVISION');
    expect(refused.error?.message).toContain(
      'a design revision after the latest prepared capsule v1 of the stream names it',
    );
    expect(refused.error?.message).toContain('Run prepare again, then complete the task under the new capsule.');

    await prepare(2);
    const completed = await complete(TASK);

    expect(completed.success, JSON.stringify(completed.error)).toBe(true);
    expect(await completionRows(TASK)).toHaveLength(1);
  });

  /** The stream holds capsule v1 only, so capsule v2 has no record to read the revisions from. */
  it('TaskComplete_AnUnpreparedCapsuleVersion_IsRefusedAsNotPrepared', async () => {
    await prepare(1);
    await gate(TASK);

    const result = await complete(TASK, 2);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPSULE_NOT_PREPARED');
    expect(result.error?.message).toContain(`No capsule v2 was prepared for '${STREAM}'`);
    expect(await completionRows(TASK)).toHaveLength(0);
  });

  /** With no version, a stream with no prepared record has no reference, so the call completes. A version refuses there. */
  it('TaskComplete_OnAStreamWithNoPreparedRecord_Completes', async () => {
    await gate(TASK);

    const refused = await complete(TASK, 1);
    expect(refused.error?.code).toBe('CAPSULE_NOT_PREPARED');

    const completed = await complete(TASK);

    expect(completed.success, JSON.stringify(completed.error)).toBe(true);
    expect(await completionRows(TASK)).toHaveLength(1);
  });

  /** The revision after the capsule names the other task too. That task has no stored completion, so the call refuses it. */
  it('TaskComplete_AStoredCompletion_IsReturnedAfterALaterRevision', async () => {
    await prepare(1);
    await gate(TASK);
    await gate(OTHER_TASK);
    const first = await complete(TASK, 1);
    expect(first.success, JSON.stringify(first.error)).toBe(true);
    const [stored] = await completionRows(TASK);

    await revise(2, [TASK, OTHER_TASK]);
    const retried = await complete(TASK, 1);

    expect(retried.success, JSON.stringify(retried.error)).toBe(true);
    expect(retried.data).toEqual({ streamId: STREAM, sequence: stored?.sequence, type: 'task.completed' });
    expect(await completionRows(TASK)).toHaveLength(1);
    const other = await complete(OTHER_TASK, 1);
    expect(other.error?.code).toBe('TASK_SUPERSEDED_BY_REVISION');
  });

  /**
   * A failure after the completion reopens the task. A later failing run refuses with `GATE_NOT_PASSED`, as before the
   * revision check. After a pass, a revision that names the task refuses, because the stored row no longer counts.
   */
  it('TaskComplete_AStoredCompletionThenAFailure_StillNeedsAPassingGate', async () => {
    await prepare(1);
    await gate(TASK);
    const first = await complete(TASK, 1);
    expect(first.success, JSON.stringify(first.error)).toBe(true);
    const failed = await handleTaskFail({ taskId: TASK, error: 'review found a defect', streamId: STREAM }, tempDir, store);
    expect(failed.success).toBe(true);
    await gate(TASK, 'fail');

    const refused = await complete(TASK, 1);

    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('GATE_NOT_PASSED');
    expect(refused.error?.unmetGates).toEqual(['static-analysis']);
    expect(refused.error?.message).toContain('is a fail');

    await gate(TASK);
    await revise(2, [TASK]);
    const superseded = await complete(TASK, 1);
    expect(superseded.error?.code).toBe('TASK_SUPERSEDED_BY_REVISION');
    expect(await completionRows(TASK)).toHaveLength(1);
  });

  /**
   * The spy appends a revision row that names the task before the first completion append. The pinned tail is then
   * stale, so the append conflicts. The next attempt reads the revision and refuses with no completion append.
   */
  it('TaskComplete_ARevisionBetweenTheReadAndTheAppend_IsReadOnTheRetryAndRefuses', async () => {
    await prepare(1);
    await gate(TASK);
    const pinned = await store.tailSequence(STREAM);
    const originalAppend = store.append.bind(store);
    const expected: (number | undefined)[] = [];
    vi.spyOn(store, 'append').mockImplementation(async (streamId, event, options) => {
      if (event.type === 'task.completed') {
        expected.push(options?.expectedSequence);
        if (expected.length === 1) {
          await originalAppend(STREAM, { type: 'design.revised', data: revisionData(2, [TASK]) });
        }
      }
      return originalAppend(streamId, event, options);
    });

    const result = await complete(TASK);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TASK_SUPERSEDED_BY_REVISION');
    expect(expected).toEqual([pinned]);
    expect(await completionRows(TASK)).toHaveLength(0);
  });

  /**
   * A failure reopens the stored completion, so the retry reaches the append. A row lands between the pin and the append.
   * The appender reads the completion key before it compares the sequence, so the retry returns the stored row and does not conflict.
   */
  it('TaskComplete_AStoredCompletionAndAStaleTail_ReturnsTheStoredRow', async () => {
    await prepare(1);
    await gate(TASK);
    const first = await complete(TASK);
    expect(first.success, JSON.stringify(first.error)).toBe(true);
    const [stored] = await completionRows(TASK);
    const failed = await handleTaskFail({ taskId: TASK, error: 'review found a defect', streamId: STREAM }, tempDir, store);
    expect(failed.success).toBe(true);
    const pinned = await store.tailSequence(STREAM);
    const originalAppend = store.append.bind(store);
    const expected: (number | undefined)[] = [];
    vi.spyOn(store, 'append').mockImplementation(async (streamId, event, options) => {
      if (event.type === 'task.completed') {
        expected.push(options?.expectedSequence);
        await originalAppend(STREAM, { type: 'workflow.prepared', data: preparedData(2) });
      }
      return originalAppend(streamId, event, options);
    });

    const retried = await complete(TASK);

    expect(retried.success, JSON.stringify(retried.error)).toBe(true);
    expect(retried.data).toEqual({ streamId: STREAM, sequence: stored?.sequence, type: 'task.completed' });
    expect(expected).toEqual([pinned]);
    expect(await completionRows(TASK)).toHaveLength(1);
  });

  /** Each completion append conflicts. The handler makes eight attempts with seven delays, and returns `CONCURRENCY_CONFLICT`. */
  it('TaskComplete_EightLostRaces_ReturnAConcurrencyConflict', async () => {
    await gate(TASK);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return realSetTimeout(() => undefined, 0);
    });
    let attempts = 0;
    const originalAppend = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (streamId, event, options) => {
      if (event.type !== 'task.completed') return originalAppend(streamId, event, options);
      attempts += 1;
      throw new SequenceConflictError(options?.expectedSequence ?? 0, (options?.expectedSequence ?? 0) + 1);
    });

    const result = await complete(TASK);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONCURRENCY_CONFLICT');
    expect(attempts).toBe(8);
    expect(delays).toEqual([20, 40, 80, 160, 320, 640, 1280]);
    expect(await completionRows(TASK)).toHaveLength(0);
  });

  /** A revision row after the capsule that the row schema refuses fails the call closed, with no row. */
  it('TaskComplete_ADamagedRevisionAfterTheCapsule_FailsClosed', async () => {
    await prepare(1);
    const { nextDesignVersion, ...damaged } = revisionData(2, [TASK]);
    expect(nextDesignVersion).toBe(2);
    await store.append(STREAM, { type: 'design.revised', data: damaged });
    await gate(TASK);

    const result = await complete(TASK, 1);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COMPLETE_FAILED');
    expect(result.error?.message).toContain('nextDesignVersion');
    expect(await completionRows(TASK)).toHaveLength(0);
  });

  /** The settlement parity compares completion rows verbatim, so the version stays off the row. An unprepared version refuses first. */
  it('TaskComplete_TheCompletionRow_CarriesNoCapsuleVersion', async () => {
    await prepare(1);
    await gate(TASK);

    const refused = await complete(TASK, 2);
    expect(refused.error?.code).toBe('CAPSULE_NOT_PREPARED');

    const completed = await complete(TASK, 1);

    expect(completed.success, JSON.stringify(completed.error)).toBe(true);
    const [row] = await completionRows(TASK);
    expect(row?.data).toEqual({ taskId: TASK, worktreePath: WORKTREE, verified: false });
  });
});

describe('the latest prepared record of a stream', () => {
  /** The last record is a second record of capsule v1. A later record that the schema refuses does not count. */
  it('LatestPreparedRecordOf_GivesTheLastRecordOfTheStream', () => {
    const { taskCount, ...damaged } = preparedData(3);
    expect(taskCount).toBe(2);
    const rows = [
      { type: 'workflow.prepared', sequence: 1, data: preparedData(1) },
      { type: 'task.completed', sequence: 2, data: { taskId: TASK, verified: false } },
      { type: 'workflow.prepared', sequence: 3, data: preparedData(2) },
      { type: 'workflow.prepared', sequence: 4, data: preparedData(1, 'digest-v1-again') },
      { type: 'workflow.prepared', sequence: 5, data: damaged },
      { type: 'design.revised', sequence: 6, data: revisionData(2, [TASK]) },
    ];

    const latest = latestPreparedRecordOf(rows);

    expect(latest?.sequence).toBe(4);
    expect(latest?.record.capsuleVersion).toBe(1);
    expect(latest?.record.capsuleDigest).toBe('digest-v1-again');
    expect(latestPreparedRecordOf(rows.filter((row) => row.type !== 'workflow.prepared'))).toBeUndefined();
    expect(latestPreparedRecordOf([])).toBeUndefined();
  });
});
