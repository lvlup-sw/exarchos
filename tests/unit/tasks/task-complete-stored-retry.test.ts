/**
 * Tests of a retry of `task_complete` for a task that a completion row already records.
 *
 * A landing or a prune can change the worktree of a completed task. A retry that no `task.failed` row reopened returns
 * the stored row and judges no tree. A failure after the completion reopens the task, so the tree rule runs again.
 * Each case makes a real repository in which the task has its own linked worktree. It spawns git, so it sets its own timeout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';

import { WIN32_SPAWN_HEADROOM } from '../../../vitest.config.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { handleTaskComplete, handleTaskFail, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../../helpers/scoped-repository.js';
import { seedStaticAnalysisVerdict } from '../../helpers/static-analysis-verdict.js';

/** The budget of one case. Each case spawns about twenty git processes. */
const CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The stream of every case. */
const STREAM = 'feat-task-complete-stored-retry';

/** The task that each case completes. */
const TASK = 'task-retry';

/** The branch that the task forks from. */
const INTEGRATION_BRANCH = 'feature/stored-retry';

/** The fixture of the checkout. */
const FIXTURE = { 'package.json': '{ "name": "stored-retry-fixture", "private": true }\n' };

let stateDir: string;
let store: EventStore;
const roots: string[] = [];

beforeEach(async () => {
  resetModuleEventStore();
  stateDir = makeTempDir('task-complete-stored-retry-');
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  resetModuleEventStore();
  store.close();
  await rmrfAsync(stateDir);
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** Makes a repository with the fixture, and deletes it after the case. */
async function makeRepository(): Promise<ScopedRepository> {
  const repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: FIXTURE });
  roots.push(repository.root);
  return repository;
}

/** The HEAD commit of a work tree. */
async function headOf(tree: string): Promise<string> {
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tree })).trim();
}

/** Seeds a passing static-analysis run of the task, whose runner row names the tree. */
async function passOn(tree: string): Promise<void> {
  await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId: TASK, stateDir, worktreePath: tree });
}

/** Calls `task_complete` for the task, and names the tree in `result.worktreePath`. */
function complete(tree: string): ReturnType<typeof handleTaskComplete> {
  return handleTaskComplete({ taskId: TASK, streamId: STREAM, result: { worktreePath: tree } }, stateDir, store);
}

/** The `task.completed` rows of the task. */
async function completionRows(): Promise<readonly WorkflowEvent[]> {
  const rows = await store.query(STREAM, { type: 'task.completed' });
  return rows.filter((row) => row.idempotencyKey === `${STREAM}:task.completed:${TASK}`);
}

/** Completes the task on its tree, and returns the stored completion row. */
async function completeOnce(tree: string): Promise<WorkflowEvent | undefined> {
  await passOn(tree);
  const first = await complete(tree);
  expect(first.success, JSON.stringify(first.error ?? null)).toBe(true);
  const [stored] = await completionRows();
  expect(first.data).toEqual({ streamId: STREAM, sequence: stored?.sequence, type: 'task.completed' });
  return stored;
}

describe('a retry of a stored completion', () => {
  /** The worktree of the task is removed after the completion, as a prune does. The retry names the removed tree. */
  it('TaskComplete_ARetryOfAStoredCompletionAfterTheWorktreeIsRemoved_ReturnsTheStoredRow', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor(TASK, { 'src/work.js': 'export const work = 1;\n' });
    const stored = await completeOnce(tree);
    await execFileAsync('git', ['worktree', 'remove', tree], { cwd: repository.checkout });
    expect(existsSync(tree)).toBe(false);

    const retried = await complete(tree);

    expect(retried.success, JSON.stringify(retried.error ?? null)).toBe(true);
    expect(retried.error).toBeUndefined();
    expect(retried.data).toEqual({ streamId: STREAM, sequence: stored?.sequence, type: 'task.completed' });
    expect(await completionRows()).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  /** The worktree gains a commit after the completion, as a landing can do. The stored row keeps the commit of the pass. */
  it('TaskComplete_ARetryAfterTheWorktreeGainsACommit_ReturnsTheStoredRow', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor(TASK);
    const stored = await completeOnce(tree);
    await repository.commitIn(TASK, { 'src/late.js': 'export const late = 1;\n' });
    expect(await headOf(tree)).not.toBe(repository.baseCommit);

    const retried = await complete(tree);

    expect(retried.success, JSON.stringify(retried.error ?? null)).toBe(true);
    expect(retried.data).toEqual({ streamId: STREAM, sequence: stored?.sequence, type: 'task.completed' });
    const rows = await completionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ worktreePath: tree, commit: repository.baseCommit });
  }, CASE_TIMEOUT_MS);

  /** The twin. A `task.failed` row after the completion reopens the task, so the tree rule judges the changed tree. */
  it('TaskComplete_AStoredCompletionThatAFailureReopened_JudgesTheTreeAgain', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor(TASK);
    await completeOnce(tree);
    const failed = await handleTaskFail({ taskId: TASK, error: 'review found a defect', streamId: STREAM }, stateDir, store);
    expect(failed.success).toBe(true);
    await repository.commitIn(TASK, { 'src/fix.js': 'export const fix = 1;\n' });
    const head = await headOf(tree);

    const retried = await complete(tree);

    expect(retried.success).toBe(false);
    expect(retried.error?.code).toBe('GATE_NOT_PASSED');
    const message = retried.error?.message ?? '';
    expect(message).toContain('the cause is other-tree');
    expect(message).toContain(`scanned '${tree}' at commit ${repository.baseCommit}`);
    expect(message).toContain(`the completion names '${tree}' at commit ${head}`);
    expect(await completionRows()).toHaveLength(1);
  }, CASE_TIMEOUT_MS);
});
