/**
 * Tests of the tree rule of `task_complete`. A passing static-analysis run completes a task only on the tree and at the
 * commit that the completion names in `result.worktreePath`. A prepared stream refuses a completion that names no tree.
 * A task run of the gate with no `repoRoot` scans nothing and records a `repo-root-missing` skip, and the completion
 * refuses on that skip.
 *
 * The cases that need a work tree make a real git repository and spawn git, so each of them sets its own timeout.
 * The gate cases point `process.cwd()` at an empty directory, so a run that scans the server directory scans nothing.
 *
 * @oracle-sources: ../../../src/verbs/tasks/tools.ts, the trees that each case makes and the rows that each case seeds
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';

import { WIN32_SPAWN_HEADROOM } from '../../../vitest.config.js';
import { GateExecutedData, WorkflowPreparedData, type WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { STATIC_ANALYSIS_STEP_PARAMS } from '../../../src/runbooks/definitions.js';
import { toPosix } from '../../../src/utils/paths.js';
import { handleStaticAnalysis } from '../../../src/verbs/gates/static-analysis.js';
import { handleTaskComplete, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../../tools/test-helpers/trusted-context.js';
import { scopedRepository, type ScopedRepository } from '../../helpers/scoped-repository.js';
import { seedStaticAnalysisVerdict } from '../../helpers/static-analysis-verdict.js';

/** The budget of one case that makes a repository. Each such case spawns about twenty git processes. */
const CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The stream of every case. */
const STREAM = 'feat-task-complete-tree';

/** The task that each case completes. */
const TASK = 'task-tree';

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/tree-rule';

/** The fixture of the checkout. */
const FIXTURE = { 'package.json': '{ "name": "tree-rule-fixture", "private": true }\n' };

let stateDir: string;
let store: EventStore;
const roots: string[] = [];

beforeEach(async () => {
  resetModuleEventStore();
  stateDir = makeTempDir('task-complete-tree-');
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
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

/** Makes a directory outside git, and deletes it after the case. Returns its canonical path. */
function makeOutsideDirectory(prefix: string): string {
  const dir = makeTempDir(prefix);
  roots.push(dir);
  return toPosix(realpathSync.native(dir));
}

/** The HEAD commit of a work tree. */
async function headOf(tree: string): Promise<string> {
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tree })).trim();
}

/** Seeds a passing static-analysis run of the task. The runner row names `worktreePath` when the seed gives one. */
async function passOn(worktreePath?: string): Promise<void> {
  await seedStaticAnalysisVerdict(store, {
    streamId: STREAM,
    taskId: TASK,
    stateDir,
    ...(worktreePath === undefined ? {} : { worktreePath }),
  });
}

/** Calls `task_complete` for the task. The completion names `worktreePath` when the call gives one. */
function complete(worktreePath?: string): ReturnType<typeof handleTaskComplete> {
  return handleTaskComplete(
    worktreePath === undefined
      ? { taskId: TASK, streamId: STREAM }
      : { taskId: TASK, streamId: STREAM, result: { worktreePath } },
    stateDir,
    store,
  );
}

/** The `task.completed` rows of the task. */
async function completionRows(): Promise<readonly WorkflowEvent[]> {
  const rows = await store.query(STREAM, { type: 'task.completed' });
  return rows.filter((row) => row.idempotencyKey === `${STREAM}:task.completed:${TASK}`);
}

/** Appends a prepared record of capsule v1, so the stream holds a prepared capsule. */
async function prepare(): Promise<void> {
  await store.append(STREAM, {
    type: 'workflow.prepared',
    data: WorkflowPreparedData.parse({
      operationId: 'prepare:digest-v1',
      workflowId: STREAM,
      workflowType: 'feature',
      capsuleVersion: 1,
      definitionVersion: 'definition-1',
      designVersion: 'design-v1',
      capsuleDigest: 'digest-v1',
      compilerVersion: 'compiler-1',
      taskCount: 1,
      requestDigest: 'request:digest-v1',
      bundleRefs: [
        { artifactId: `run-bundle:settlement:${STREAM}:1`, digest: { algorithm: 'sha256', value: 'a'.repeat(64) } },
      ],
    }),
  });
}

/** The params of the static-analysis step, as a rerun for the task names each of them. */
function rerunParams(): readonly string[] {
  return Object.entries(STATIC_ANALYSIS_STEP_PARAMS).map(([name, value]) => `${name} '${value.replaceAll('<taskId>', TASK)}'`);
}

/** Runs the real static-analysis gate for the task with no `repoRoot`, inside a trusted dispatch scope. */
async function runGateWithNoRepoRoot(): Promise<Awaited<ReturnType<typeof handleStaticAnalysis>>> {
  await seedActivePhaseAttempt(store, STREAM);
  return runAsTrustedCaller(stateDir, () => handleStaticAnalysis({ featureId: STREAM, taskId: TASK }, stateDir, store));
}

describe('task_complete accepts only a pass on the named tree and commit', () => {
  /** The kill fixture of the wrong tree. The pass is on one worktree, and the completion names another one. */
  it('TaskComplete_APassOnAnotherTree_IsRefusedAsOtherTreeWithNoRow', async () => {
    const repository = await makeRepository();
    const scanned = await repository.worktreeFor('task-scanned');
    const named = await repository.worktreeFor('task-named', { 'src/named.js': 'export const named = 1;\n' });
    await passOn(scanned);

    const result = await complete(named);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toEqual(['static-analysis']);
    const message = result.error?.message ?? '';
    expect(message).toContain('the cause is other-tree');
    expect(message).toContain(`scanned '${scanned}' at commit ${repository.baseCommit}`);
    expect(message).toContain(`the completion names '${named}' at commit ${await headOf(named)}`);
    expect(message).toContain('Name the worktree of the task in result.worktreePath');
    for (const param of rerunParams()) expect(message).toContain(param);
    expect(await completionRows()).toHaveLength(0);
  }, CASE_TIMEOUT_MS);

  /** The pass is on the named tree, and then the tree gets a new commit. The pass names the earlier commit. */
  it('TaskComplete_ACommitAfterThePass_IsRefusedAsOtherTree', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor(TASK);
    await passOn(tree);
    await repository.commitIn(TASK, { 'src/late.js': 'export const late = 1;\n' });
    const head = await headOf(tree);
    expect(head).not.toBe(repository.baseCommit);

    const result = await complete(tree);

    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    const message = result.error?.message ?? '';
    expect(message).toContain('the cause is other-tree');
    expect(message).toContain(`scanned '${tree}' at commit ${repository.baseCommit}`);
    expect(message).toContain(`the completion names '${tree}' at commit ${head}`);
    expect(await completionRows()).toHaveLength(0);
  }, CASE_TIMEOUT_MS);

  /**
   * The pass is on the named tree at its head. The completion names the tree with a trailing separator, and the row
   * carries the canonical root and the observed head.
   */
  it('TaskComplete_APassOnTheNamedTreeAtItsHead_CompletesWithThePathAndTheCommit', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor(TASK, { 'src/work.js': 'export const work = 1;\n' });
    const head = await headOf(tree);
    await passOn(tree);

    const result = await complete(`${tree}/`);

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
    const [row] = await completionRows();
    expect(row?.data).toEqual({ taskId: TASK, worktreePath: tree, commit: head, verified: false });
  }, CASE_TIMEOUT_MS);

  /** A prepared stream refuses a completion that names no tree, also with a passing run of the task. */
  it('TaskComplete_OnAPreparedStreamWithNoNamedTree_IsRefusedAsTreeUnnamed', async () => {
    await prepare();
    await passOn('/nonexistent-task-complete-tree');

    const result = await complete();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    const message = result.error?.message ?? '';
    expect(message).toContain('the cause is tree-unnamed');
    expect(message).toContain(`the completion of task '${TASK}' names no tree in result.worktreePath`);
    expect(message).toContain('Name the worktree of the task in result.worktreePath');
    for (const param of rerunParams()) expect(message).toContain(param);
    expect(await completionRows()).toHaveLength(0);
  });

  /** A runner row of an earlier build names no tree, so it does not satisfy a completion that names one. */
  it('TaskComplete_ARunnerRowWithNoTree_DoesNotSatisfyANamedTree', async () => {
    await passOn();
    const [signal] = await store.query(STREAM, { type: 'gate.executed' });
    expect(GateExecutedData.parse(signal?.data).details).not.toHaveProperty('worktree');

    const result = await complete('/nonexistent-task-complete-tree');

    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    const message = result.error?.message ?? '';
    expect(message).toContain('the cause is other-tree');
    expect(message).toContain(`The latest passing static-analysis run for task '${TASK}' names no tree`);
    expect(message).toContain("The completion names '/nonexistent-task-complete-tree' with no commit");
    expect(await completionRows()).toHaveLength(0);
  });

  /** Two directories outside git compare by their paths. The other directory refuses, and the scanned one completes. */
  it('TaskComplete_ANamedTreeOutsideGitThatDiffersFromTheRow_IsRefusedAsOtherTree', async () => {
    const scanned = makeOutsideDirectory('task-complete-tree-scanned-');
    const other = makeOutsideDirectory('task-complete-tree-other-');
    await passOn(scanned);

    const refused = await complete(other);

    expect(refused.error?.code).toBe('GATE_NOT_PASSED');
    const message = refused.error?.message ?? '';
    expect(message).toContain('the cause is other-tree');
    expect(message).toContain(`scanned '${scanned}' with no commit`);
    expect(message).toContain(`the completion names '${other}' with no commit`);
    expect(await completionRows()).toHaveLength(0);

    const completed = await complete(scanned);

    expect(completed.success, JSON.stringify(completed.error ?? null)).toBe(true);
    const [row] = await completionRows();
    expect(row?.data).toEqual({ taskId: TASK, worktreePath: scanned, verified: false });
  }, CASE_TIMEOUT_MS);
});

describe('check_static_analysis with a task and no repoRoot', () => {
  /** The run records a skip through the gate runner. Its row names the cause and no tree, and nothing is scanned. */
  it('StaticAnalysis_ATaskRunWithNoRepoRoot_RecordsARepoRootMissingSkipAndScansNothing', async () => {
    const empty = makeOutsideDirectory('task-complete-tree-cwd-');
    vi.spyOn(process, 'cwd').mockReturnValue(empty);

    const result = await runGateWithNoRepoRoot();

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
    expect(result.data).toMatchObject({
      verdict: 'indeterminate',
      passed: false,
      skipped: true,
      skipReason: 'repo-root-missing',
      discriminant: 'repo-root-missing',
      reason: 'the call named a task and no repoRoot, so the run scanned nothing',
      passCount: 0,
      failCount: 0,
      skipCount: 0,
    });
    expect(await store.query(STREAM, { type: 'admission.evidence-recorded' })).toHaveLength(1);
    const signals = await store.query(STREAM, { type: 'gate.executed' });
    expect(signals).toHaveLength(1);
    const details = GateExecutedData.parse(signals[0]?.data).details;
    expect(details).toMatchObject({ taskId: TASK, skipped: true, discriminant: 'repo-root-missing' });
    expect(details).not.toHaveProperty('worktree');
    expect(details).not.toHaveProperty('head');
  }, CASE_TIMEOUT_MS);

  /** The completion after the skip names the cause and the rerun with the params of the runbook step. */
  it('TaskComplete_AfterARepoRootMissingSkip_IsRefusedWithTheRerunRecovery', async () => {
    const empty = makeOutsideDirectory('task-complete-tree-cwd-');
    vi.spyOn(process, 'cwd').mockReturnValue(empty);
    expect((await runGateWithNoRepoRoot()).success).toBe(true);

    const result = await complete('/nonexistent-task-complete-tree');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    const message = result.error?.message ?? '';
    expect(message).toContain(`The latest static-analysis run for task '${TASK}' is a repo-root-missing skip`);
    expect(message).toContain('so the run scanned nothing');
    expect(message).toContain('Name the worktree of the task in result.worktreePath');
    for (const param of rerunParams()) expect(message).toContain(param);
    expect(await completionRows()).toHaveLength(0);
  }, CASE_TIMEOUT_MS);
});
