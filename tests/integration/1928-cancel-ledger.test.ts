// @oracle-sources: a real Git repository with a bare origin and a linked worktree, the SQLite event rows read directly, and literal expected records
/**
 * A cancel records the resources of the workflow in the ledger and starts no process.
 * Each case drives `handleCancel` against a real event store. The repository case also has a real repository, branches and a worktree.
 * The branches and the worktree stay after the cancel, and the trail holds one `workflow.compensation` row for each action.
 * A missing resource stays outstanding, a prior failed removal stays a failure, and a worktree reservation stays until a release.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/events/store.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { handleCancel } from '../../src/workflow/cancel.js';
import { handleInit } from '../../src/workflow/tools.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';
import { WORKTREES_STREAM, WorktreeManager } from '../../src/verbs/worktree/manager.js';
import { createWorktreesReducer } from '../../src/verbs/worktree/projections/worktrees.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The feature id of each case. Each case has its own store. */
const FEATURE_ID = 'cancel-ledger';

/** The resources of one workflow, in the shape of the workflow state. */
interface Resources {
  readonly integrationBranch: string;
  readonly prUrl: string;
  readonly worktreePath: string;
  readonly taskBranch: string;
}

/** Runs one Git command in a directory and returns its trimmed output. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/** Opens an event store on a new temporary directory. */
async function openStore(): Promise<{ readonly stateDir: string; readonly store: EventStore }> {
  const stateDir = makeTempDir('1928-cancel-ledger-');
  cleanup.push(() => rmrfAsync(stateDir));
  const store = new EventStore(stateDir);
  await store.initialize();
  cleanup.push(() => store.close());
  return { stateDir, store };
}

/**
 * Builds a repository with a task branch and an integration branch, both pushed to a bare origin,
 * and a linked worktree on the task branch.
 */
async function repositoryWithResources(): Promise<Resources & { readonly repo: string }> {
  const root = makeTempDir('1928-cancel-ledger-repo-');
  cleanup.push(() => rmrfAsync(root));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  await execFileAsync('git', ['init', '-q', repo]);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), '# fixture\n', 'utf8');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-q', '-m', 'fixture');
  await git(repo, 'branch', 'task/one');
  await git(repo, 'branch', 'integrate/ledger');
  await execFileAsync('git', ['init', '--bare', '-q', origin]);
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', '-q', 'origin', 'task/one', 'integrate/ledger');
  const worktreePath = join(root, 'wt-one');
  await git(repo, 'worktree', 'add', '-q', worktreePath, 'task/one');
  return {
    repo,
    integrationBranch: 'integrate/ledger',
    prUrl: 'https://example.invalid/pull/31',
    worktreePath,
    taskBranch: 'task/one',
  };
}

/** Starts a feature workflow at `synthesize` whose rows and document name the resources. */
async function seedWorkflow(stateDir: string, store: EventStore, resources: Resources): Promise<void> {
  await handleInit({ featureId: FEATURE_ID, workflowType: 'feature' }, stateDir, store);
  await store.append(FEATURE_ID, {
    type: 'workflow.transition',
    data: { from: 'plan', to: 'synthesize', trigger: 'test', featureId: FEATURE_ID },
  });
  const patch = {
    worktrees: { one: { branch: resources.taskBranch, taskId: 'one', status: 'active', path: resources.worktreePath } },
    tasks: [{ id: 'one', title: 'One', status: 'complete', branch: resources.taskBranch }],
    synthesis: { integrationBranch: resources.integrationBranch, prUrl: resources.prUrl, mergeOrder: [], mergedBranches: [], prFeedback: [] },
  };
  await store.append(FEATURE_ID, { type: 'state.patched', data: { patch } });
  const file = join(stateDir, `${FEATURE_ID}.state.json`);
  const state: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...state, ...patch, phase: 'synthesize' }, null, 2), 'utf8');
}

/** Returns the cancel id that a cancel of the seeded state allocates. */
async function cancelIdOf(stateDir: string): Promise<{ readonly cancelId: string; readonly phaseAttemptId: string }> {
  const state: Record<string, unknown> = JSON.parse(await readFile(join(stateDir, `${FEATURE_ID}.state.json`), 'utf8'));
  const phaseAttemptId = allocatePhaseAttemptId(FEATURE_ID, 'synthesize', 'cancelled', state.phaseAttemptId, Number(state._version ?? 1));
  return { cancelId: `cancel:${phaseAttemptId}`, phaseAttemptId };
}

/** Returns the data of each row of one type, in order. */
function dataOf(rows: readonly WorkflowEvent[], type: string): Record<string, unknown>[] {
  return rows.filter((row) => row.type === type).map((row) => ({ ...row.data }));
}

/** The four records that a cancel of the seeded resources writes, in the order of the trail. */
function expectedRecords(resources: Resources): Record<string, unknown>[] {
  return [
    {
      featureId: FEATURE_ID,
      actionId: 'synthesize:close-pr',
      status: 'outstanding',
      message: `Recorded PR as outstanding: ${resources.prUrl}`,
      resources: [{ kind: 'pull-request', ref: resources.prUrl, status: 'outstanding' }],
    },
    {
      featureId: FEATURE_ID,
      actionId: 'delegate:delete-integration-branch',
      status: 'outstanding',
      message: `Recorded integration branch as outstanding: ${resources.integrationBranch}`,
      resources: [{ kind: 'integration-branch', ref: resources.integrationBranch, status: 'outstanding' }],
    },
    {
      featureId: FEATURE_ID,
      actionId: 'delegate:cleanup-worktrees',
      status: 'outstanding',
      message: `Recorded 1 worktree(s) as outstanding: ${resources.worktreePath}`,
      resources: [{ kind: 'worktree', ref: resources.worktreePath, status: 'outstanding' }],
    },
    {
      featureId: FEATURE_ID,
      actionId: 'delegate:delete-feature-branches',
      status: 'outstanding',
      message: `Recorded 1 feature branch(es) as outstanding: ${resources.taskBranch}`,
      resources: [{ kind: 'feature-branch', ref: resources.taskBranch, status: 'outstanding' }],
    },
  ];
}

describe('ledger-only cancellation', () => {
  /** The branches, the remote branches and the worktree stay after the cancel. The trail records each one as outstanding. */
  it('CancelLedger_ARealCancel_LeavesEachResourceAndRecordsItOutstanding', async () => {
    const resources = await repositoryWithResources();
    const { stateDir, store } = await openStore();
    await seedWorkflow(stateDir, store, resources);

    const result = await handleCancel({ featureId: FEATURE_ID }, stateDir, store);

    expect(result.success).toBe(true);
    const records = expectedRecords(resources);
    expect(result.data).toMatchObject({
      phase: 'cancelled',
      actions: records.map(({ featureId: _featureId, ...action }) => action),
    });
    const rows = await store.query(FEATURE_ID);
    expect(dataOf(rows, 'workflow.compensation')).toEqual(records);
    const completed = rows.filter((row) => row.type === 'cancel.compensation-completed').map((row) => row.data?.status);
    expect(completed).toEqual(['outstanding', 'outstanding', 'outstanding', 'outstanding']);
    expect(rows.filter((row) => row.type.startsWith('branch.delete.') || row.type.startsWith('worktree.'))).toHaveLength(0);
    expect((await store.query(WORKTREES_STREAM)).length).toBe(0);

    await git(resources.repo, 'rev-parse', '--verify', resources.taskBranch);
    await git(resources.repo, 'rev-parse', '--verify', resources.integrationBranch);
    expect(await git(resources.repo, 'ls-remote', '--heads', 'origin', resources.taskBranch)).not.toBe('');
    expect(await git(resources.repo, 'ls-remote', '--heads', 'origin', resources.integrationBranch)).not.toBe('');
    await access(resources.worktreePath);
    expect(await git(resources.repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${resources.worktreePath}`);
  });

  /** Resources that exist nowhere are never read as removed. Each one stays outstanding in the trail. */
  it('CancelLedger_MissingResources_StayOutstanding', async () => {
    const { stateDir, store } = await openStore();
    const resources: Resources = {
      integrationBranch: 'integrate/absent',
      prUrl: 'https://example.invalid/pull/0',
      worktreePath: join(stateDir, `absent-${randomUUID()}`),
      taskBranch: 'task/absent',
    };
    await seedWorkflow(stateDir, store, resources);

    const result = await handleCancel({ featureId: FEATURE_ID }, stateDir, store);

    expect(result.success).toBe(true);
    expect(dataOf(await store.query(FEATURE_ID), 'workflow.compensation')).toEqual(expectedRecords(resources));
  });

  /** An earlier attempt of this cancel recorded a failed worktree removal. The cancel keeps the failure and never finishes. */
  it('CancelLedger_APriorFailedRemoval_StaysAFailure', async () => {
    const { stateDir, store } = await openStore();
    const resources: Resources = {
      integrationBranch: 'integrate/failed',
      prUrl: 'https://example.invalid/pull/1',
      worktreePath: join(stateDir, 'wt-failed'),
      taskBranch: 'task/failed',
    };
    await seedWorkflow(stateDir, store, resources);
    const { cancelId, phaseAttemptId } = await cancelIdOf(stateDir);
    await store.append(FEATURE_ID, {
      type: 'cancel.compensation-failed',
      data: {
        eventVersion: '1.0',
        cancelId,
        featureId: FEATURE_ID,
        phaseAttemptId,
        actionId: 'delegate:cleanup-worktrees',
        reason: 'effect-failed',
        message: 'worktree remove failed',
        failedAt: new Date().toISOString(),
      },
    });

    const result = await handleCancel({ featureId: FEATURE_ID }, stateDir, store);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COMPENSATION_PARTIAL');
    expect(result.error?.message).toContain('delegate:cleanup-worktrees');
    const rows = await store.query(FEATURE_ID);
    const worktreeOutcomes = rows.filter(
      (row) => row.type.startsWith('cancel.compensation-') && row.data?.actionId === 'delegate:cleanup-worktrees',
    );
    expect(worktreeOutcomes.some((row) => row.type === 'cancel.compensation-completed')).toBe(false);
    expect(rows.some((row) => row.type === 'cancel.ready')).toBe(false);
    expect(rows.some((row) => row.type === 'workflow.cancel')).toBe(false);
    expect(rows.some((row) => row.type === 'workflow.compensation')).toBe(false);
  });

  /** A cancel leaves the reservation of a workflow worktree outstanding. `release_worktree` then clears it. */
  it('CancelLedger_AWorktreeReservation_StaysUntilARelease', async () => {
    const { stateDir, store } = await openStore();
    const resources: Resources = {
      integrationBranch: 'integrate/reserved',
      prUrl: 'https://example.invalid/pull/2',
      worktreePath: join(stateDir, 'wt-reserved'),
      taskBranch: 'task/reserved',
    };
    await seedWorkflow(stateDir, store, resources);
    const manager = new WorktreeManager({ eventStore: store, realpath: (value) => value });
    const owner = { ownerPid: process.pid, ownerStartedAt: 'fixture-start' };
    const reserved = await manager.reserve({ worktreeId: resources.worktreePath, path: resources.worktreePath, featureId: FEATURE_ID, ...owner });
    expect(reserved.reserved).toBe(true);
    const reducer = createWorktreesReducer((value) => value);
    const live = async () => (await store.query(WORKTREES_STREAM)).reduce((acc, row) => reducer.apply(acc, row), reducer.initial);

    const result = await handleCancel({ featureId: FEATURE_ID }, stateDir, store);

    expect(result.success).toBe(true);
    expect((await live()).worktrees[resources.worktreePath]).toMatchObject({ featureId: FEATURE_ID, ownerPid: process.pid });

    const released = await manager.release(resources.worktreePath, owner);
    expect(released.released).toBe(true);
    expect((await live()).worktrees[resources.worktreePath]?.ownerPid ?? null).toBeNull();
  });
});
