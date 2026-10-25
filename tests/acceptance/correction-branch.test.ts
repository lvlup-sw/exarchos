/**
 * The place of a fix after a static-analysis failure, through the real dispatcher.
 *
 * One low-risk task fails static analysis in its own linked worktree. A fix lands in one of three
 * places, and a correction under a new batch id claims it. Each claim names its branch.
 *
 * The static-analysis record keys on the branch. So a fix on the earlier branch supersedes the
 * failing record, in the earlier worktree or in a new one. A fix on a new branch leaves that record
 * active, and the completion leaf refuses the task until a named rerun on the earlier branch.
 *
 * The cases drive git directly, with no agent. So they show what settle accepts, not what an agent
 * does. They turn telemetry off and keep the state document in the JSON file form, and the
 * reachable-controls policy records both.
 *
 * @oracle-sources: ../../src/verbs/settle/handler.ts, the receipts of each dispatched call and the rows of the real event store, worked out by hand in each case
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { ExecutionSettledData } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { initStateFile } from '../../src/workflow/state-store.js';
import { execFileAsync, spawnAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-correction-branch-acceptance';
const TASK = 'task-a';
/** The branch that the worktree of the task holds. The helper names it after the task. */
const TASK_BRANCH = `task/${TASK}`;
/** The branch that each task forks from. `prepare` freezes it in the capsule. */
const INTEGRATION_BRANCH = 'feature/correction-branch';
/** Real npm scripts: the cheapest processes that exit 0 and 1. */
const OK = 'node -e ""';
const FAIL = 'node -e "process.exit(1)"';

/** The files of a Node project that the production static-analysis gate runs with the given scripts. */
function nodeProject(scripts: Record<string, string>): Record<string, string> {
  return { 'package.json': JSON.stringify({ name: 'correction-branch-fixture', version: '1.0.0', private: true, scripts }, null, 2) };
}

/** The green fixture of the integration branch: each script exits 0. */
const GREEN_PROJECT = nodeProject({ lint: OK, typecheck: OK, 'quality-check': OK });
/** The red work of the task: lint exits 1, so static analysis fails. */
const RED_PROJECT = nodeProject({ lint: FAIL, typecheck: OK, 'quality-check': OK });
/** The work of the task done again on a new branch: a source file, with the green scripts of the base. */
const REDONE_WORK = { ...GREEN_PROJECT, 'src/work.js': 'export const work = 1;\n' };

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = makeTempDir('correction-branch-acceptance-');
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: GREEN_PROJECT });
  scratchDirs.push(repository.root);
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The dispatch context of an agent, with telemetry off, so each case reads only the rows of the calls under test. */
function callerContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'correction-branch-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

function call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return dispatch(tool, args, callerContext());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runs one git command in a directory and returns its output. */
function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', [...args], { cwd });
}

/** Seeds a feature workflow in `delegate` with one low-risk task and its integration branch. */
async function seedDelegatingFeature(): Promise<void> {
  const tasks = [{ id: TASK, title: 'the work', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }];
  await initStateFile(stateDir, STREAM, 'feature', { phase: 'delegate', tasks: tasks.map(({ id, title, status }) => ({ id, title, status })) });
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, { type: 'state.patched', data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks } } });
}

/** Runs `prepare` and returns the capsule version of its receipt. */
async function prepare(): Promise<number> {
  const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  const version = isRecord(prepared.data) ? prepared.data.capsuleVersion : undefined;
  if (typeof version !== 'number') throw new Error(`prepare returned no capsule version: ${JSON.stringify(prepared)}`);
  return version;
}

/** One `settle` call that claims the task as complete in a worktree, on a branch. */
function settle(capsuleVersion: number, batchId: string, worktreePath: string, branch: string): Promise<ToolResult> {
  return call('exarchos_orchestrate', {
    action: 'settle',
    featureId: STREAM,
    capsuleVersion,
    batchId,
    claims: [{ taskId: TASK, fields: { worktreePath, branch, files: ['package.json'] }, evidence: [] }],
  });
}

/** The outcome of a receipt, its accepted tasks, and the task, the outcome and the halted leaf of each trace. */
function verdictOf(result: ToolResult): unknown[] {
  const data = isRecord(result.data) ? result.data : {};
  const traces = Array.isArray(data.verification) ? data.verification : [];
  return [data.outcome, data.acceptedTasks, traces.map((trace) => (isRecord(trace) ? [trace.taskId, trace.outcome, trace.failedLeaf] : trace))];
}

/** The verdict of a first batch whose static analysis failed: a correction, with the task unresolved. */
const FAILED_BATCH = ['corrective-capsule', [], [[TASK, 'failed', 'check_static_analysis']]];
/** The verdict of a correction that verified the task. */
const SETTLED_BATCH = ['settled', [TASK], [[TASK, 'verified', undefined]]];

/** The batch and the outcome of each settlement row, in commit order. */
async function settlementRows(): Promise<unknown[][]> {
  return (await eventStore.query(STREAM, { type: 'execution.settled' })).map((row) => {
    const record = ExecutionSettledData.parse(row.data);
    return [record.batchId, record.outcome];
  });
}

/** The task of each completion row, in commit order. */
async function completionRows(): Promise<unknown[]> {
  return (await eventStore.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** The evidence id and the verdict of each static-analysis runner row of the task, in commit order. */
async function staticAnalysisRows(): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for (const row of await eventStore.query(STREAM, { type: 'gate.executed' })) {
    const data = isRecord(row.data) ? row.data : {};
    const details = isRecord(data.details) ? data.details : {};
    if (data.gateName === 'static-analysis' && details.taskId === TASK) rows.push([details.evidenceId, details.verdict]);
  }
  return rows;
}

describe('a correction after a static-analysis failure, through the dispatcher', () => {
  /**
   * The fix is a new commit on the branch of the task, in the same worktree. This is the route of a runtime with no
   * native isolation. The rerun keys on the same branch, so it supersedes the failing record, and the correction settles.
   */
  it('CorrectionBranch_AFixOnTheEarlierBranch_SettlesAfterAStaticAnalysisFailure', async () => {
    await seedDelegatingFeature();
    const worktree = await repository.worktreeFor(TASK, RED_PROJECT);
    const capsuleVersion = await prepare();

    const failed = await settle(capsuleVersion, 'batch-1', worktree, TASK_BRANCH);
    expect(failed.success, JSON.stringify(failed)).toBe(true);
    expect(verdictOf(failed)).toEqual(FAILED_BATCH);

    await repository.commitIn(TASK, GREEN_PROJECT);
    const corrected = await settle(capsuleVersion, 'batch-1-correction', worktree, TASK_BRANCH);

    expect(corrected.success, JSON.stringify(corrected)).toBe(true);
    expect(verdictOf(corrected)).toEqual(SETTLED_BATCH);
    expect(await settlementRows()).toEqual([
      ['batch-1', 'corrective-capsule'],
      ['batch-1-correction', 'settled'],
    ]);
    expect(await completionRows()).toEqual([TASK]);
    expect((await staticAnalysisRows()).map(([, verdict]) => verdict)).toEqual(['fail', 'pass']);
  });

  /**
   * The fixer gets a new worktree of its own, as under native isolation. Git refuses to switch it to the earlier
   * branch while the earlier worktree holds that branch. The case then removes the earlier worktree, switches the new
   * worktree to the earlier branch and commits the fix there. The claim names the new worktree and the earlier branch,
   * and the correction settles.
   */
  it('CorrectionBranch_AFixInANewWorktreeOnTheEarlierBranch_SettlesAfterTheEarlierWorktreeIsRemoved', async () => {
    await seedDelegatingFeature();
    const earlier = await repository.worktreeFor(TASK, RED_PROJECT);
    const capsuleVersion = await prepare();

    const failed = await settle(capsuleVersion, 'batch-1', earlier, TASK_BRANCH);
    expect(failed.success, JSON.stringify(failed)).toBe(true);
    expect(verdictOf(failed)).toEqual(FAILED_BATCH);

    const fixer = await repository.worktreeFor('fixer');
    const refusedSwitch = await spawnAsync('git', ['switch', '-q', TASK_BRANCH], { cwd: fixer });
    expect(refusedSwitch.status).not.toBe(0);
    expect(refusedSwitch.stderr).toContain(path.posix.basename(earlier));
    await git(repository.checkout, ['worktree', 'remove', earlier]);
    await git(fixer, ['switch', '-q', TASK_BRANCH]);
    await repository.commitIn('fixer', GREEN_PROJECT);
    expect((await git(fixer, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(TASK_BRANCH);

    const corrected = await settle(capsuleVersion, 'batch-1-correction', fixer, TASK_BRANCH);

    expect(corrected.success, JSON.stringify(corrected)).toBe(true);
    expect(verdictOf(corrected)).toEqual(SETTLED_BATCH);
    expect(await settlementRows()).toEqual([
      ['batch-1', 'corrective-capsule'],
      ['batch-1-correction', 'settled'],
    ]);
    expect(await completionRows()).toEqual([TASK]);
  });

  /**
   * The fix is on a new branch in a new worktree. The rerun of the segment keys on the new branch, so the failing
   * record of the earlier branch stays active. The completion leaf refuses the task and names that record, and the
   * call records no settlement row and no completion. The named rerun of static analysis with the earlier branch on
   * the new tree supersedes the failing record. A settle under a new batch id then settles.
   */
  it('CorrectionBranch_AFixOnANewBranch_HaltsAtTheCompletionLeafUntilTheNamedRerun', async () => {
    await seedDelegatingFeature();
    const earlier = await repository.worktreeFor(TASK, RED_PROJECT);
    const capsuleVersion = await prepare();

    const failed = await settle(capsuleVersion, 'batch-1', earlier, TASK_BRANCH);
    expect(failed.success, JSON.stringify(failed)).toBe(true);
    expect(verdictOf(failed)).toEqual(FAILED_BATCH);
    const [failingRecord] = await staticAnalysisRows();
    const failingEvidenceId = failingRecord?.[0];
    if (typeof failingEvidenceId !== 'string') throw new Error('the failed batch left no static-analysis runner row');

    const retry = await repository.worktreeFor('retry', REDONE_WORK);
    const retryBranch = 'task/retry';
    const halted = await settle(capsuleVersion, 'batch-2', retry, retryBranch);

    expect(halted.success, JSON.stringify(halted)).toBe(false);
    expect(halted.error?.message).toContain("halted on 'task_complete'");
    expect(halted.error?.message).toContain(`evidence '${failingEvidenceId}'`);
    expect(await settlementRows()).toEqual([['batch-1', 'corrective-capsule']]);
    expect(await completionRows()).toEqual([]);

    const rerun = await call('exarchos_orchestrate', {
      action: 'check_static_analysis',
      featureId: STREAM,
      taskId: TASK,
      branch: TASK_BRANCH,
      repoRoot: 'auto',
      worktreePath: retry,
    });
    expect(rerun.success, JSON.stringify(rerun)).toBe(true);
    expect(isRecord(rerun.data) ? rerun.data.passed : undefined).toBe(true);

    const settled = await settle(capsuleVersion, 'batch-3', retry, retryBranch);

    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(verdictOf(settled)).toEqual(SETTLED_BATCH);
    expect(await settlementRows()).toEqual([
      ['batch-1', 'corrective-capsule'],
      ['batch-3', 'settled'],
    ]);
    expect(await completionRows()).toEqual([TASK]);
  });
});
