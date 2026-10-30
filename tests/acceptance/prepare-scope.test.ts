/**
 * `prepare` pins the repository of `repoRoot` and the commit of the base, through the real dispatcher and real git.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver, and with telemetry at its shipped default.
 * Each workflow is seeded as rows of the event store only, so no case writes a state document.
 * The repository of each case comes from the scoped repository helper. Each blocker of a later batch works on a task branch of its own.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 *
 * @oracle-sources: ../../src/verbs/prepare/handler.ts, the plane rows and the blobs counted out of the real event store and bundle store, the commits that real git reports in each case
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { loadProjectConfig } from '../../src/config/yaml-loader.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { handlePrepare } from '../../src/verbs/prepare/handler.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { canonicalPath } from '../../src/utils/git-tree.js';
import { scopedRepository, type FixtureFiles, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-prepare-scope-acceptance';
const INTEGRATION_BRANCH = 'feature/prepare-scope';
/** The budget of one case. Each case spawns up to about twenty git processes. */
const CASE_TIMEOUT_MS = 60_000 * WIN32_SPAWN_HEADROOM;

/** The files of the integration branch: a manifest and one source file in a subdirectory. */
const FIXTURE: FixtureFiles = {
  'package.json': '{ "name": "prepare-scope-fixture", "private": true }\n',
  'src/index.js': 'export const value = 1;\n',
};

/** The plane rows that a recorded prepare appends. A refused prepare appends none of them. */
const PLANE_ROW_TYPES: readonly string[] = ['workflow.prepared', 'task.assigned', 'capsule.recompiled'];

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-scope-acceptance-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: FIXTURE });
  scratchDirs.push(repository.root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The dispatch context of an agent, with telemetry at its shipped default. */
function callerContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'prepare-scope-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

async function call(args: Record<string, unknown>, context: DispatchContext = callerContext()): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch('exarchos_orchestrate', { action: 'prepare', ...args }, context));
}

/** The fields of a receipt that the cases read. The parse checks them, so no case trusts the shape of the data. */
const ReceiptView = z.object({ capsuleVersion: z.number().int(), capsule: ExarchosCapsuleV1Schema });

type Receipt = z.infer<typeof ReceiptView>;

function receiptOf(result: CallResult): Receipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return ReceiptView.parse(result.data);
}

/** The code and the message of a refused call. */
function refusalOf(result: CallResult): { readonly code: string; readonly message: string } {
  expect(result.success, JSON.stringify(result)).toBe(false);
  return { code: result.error?.code ?? '', message: result.error?.message ?? '' };
}

/** One task of the plan. A task that is not complete waits on its blockers. */
interface PlannedTask {
  readonly id: string;
  readonly status: 'pending' | 'complete';
  readonly blockedBy?: readonly string[];
}

/** The plan of most cases: two ready tasks. */
const READY_PLAN: readonly PlannedTask[] = [
  { id: 'task-a', status: 'pending' },
  { id: 'task-b', status: 'pending' },
];

/** The rows of a plan, low-risk and off the boundary. */
function planRows(tasks: readonly PlannedTask[]): Record<string, unknown>[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.id,
    status: task.status,
    blockedBy: task.blockedBy ?? [],
    riskTier: 'low',
    boundaryTouching: false,
  }));
}

/** A feature workflow in `delegate` with the given plan and integration branch, as rows of the event store only. */
async function seed(tasks: readonly PlannedTask[] = READY_PLAN, integrationBranch = INTEGRATION_BRANCH): Promise<void> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': integrationBranch, tasks: planRows(tasks) } },
  });
}

/** Puts another plan in place of the plan of the seeded workflow. */
async function replan(tasks: readonly PlannedTask[]): Promise<void> {
  await eventStore.append(STREAM, { type: 'state.patched', data: { patch: { tasks: planRows(tasks) } } });
}

/** Records the completion of a task at a commit, as `task_complete` writes it for a named tree. */
async function recordCompletion(taskId: string, worktreePath: string, commit: string): Promise<void> {
  await eventStore.append(STREAM, {
    type: 'task.completed',
    data: { taskId, worktreePath, commit, verified: true, evidence: { type: 'test', output: 'pass', passed: true } },
  });
}

/** The plane rows of the stream, by type, in commit order. */
async function planeRows(): Promise<string[]> {
  return (await eventStore.query(STREAM)).filter((event) => PLANE_ROW_TYPES.includes(event.type)).map((event) => event.type);
}

/** The number of blobs in the bundle store. A refused prepare writes none. */
async function blobCount(): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(eventStore.bundleStore.root);
  return count;
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

/** The sha256 of a text, in bare hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A config of the server directory: a policy that adds the mock-boundary gate to the low tier. */
const FOREIGN_CONFIG = 'verification:\n  policy:\n    low: [check_static_analysis, check_mock_boundary]\n';

describe('prepare pins the scope of repoRoot', () => {
  /**
   * The server directory is another repository with a config of its own: the process directory, the dispatch workspace and the server config.
   * The capsule pins the repository and the checkout of `repoRoot`, the commit of its base, and the digest of its two absent config files.
   * The gate sequence follows the checkout, which holds no config, so the mock-boundary gate of the server policy is absent.
   */
  it('Prepare_FromAServerInAForeignRepository_PinsTheScopeOfRepoRoot', async () => {
    await seed();
    const foreign = await scopedRepository({
      integrationBranch: 'feature/foreign',
      files: { ...FIXTURE, '.exarchos.yml': FOREIGN_CONFIG },
    });
    scratchDirs.push(foreign.root);
    vi.spyOn(process, 'cwd').mockReturnValue(foreign.checkout);
    const server = { ...callerContext(), cwd: foreign.checkout, projectConfig: resolveConfig(loadProjectConfig(foreign.checkout)) };

    const receipt = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }, server));
    const { settlementContract, knowledge } = receipt.capsule;
    expect(settlementContract.scope).toStrictEqual({
      repository: `${repository.checkout}/.git`,
      checkout: repository.checkout,
      configDigest: sha256('[{"digest":null,"name":".exarchos.yml"},{"digest":null,"name":".exarchos.yaml"}]'),
    });
    expect(settlementContract.taskVerification?.['task-a']?.baseCommit).toBe(repository.baseCommit);
    expect(knowledge.patterns.map((pattern) => pattern.statement)).toStrictEqual([
      'A task at riskTier=low, boundaryTouching=false is verified at settlement by: check_static_analysis.',
      `Each task forks from ${INTEGRATION_BRANCH} at ${repository.baseCommit}. Settlement refuses a worktree that does not hold ${repository.baseCommit}.`,
    ]);
    expect(receipt.capsule.provenance.compilerVersion).toBe('exarchos-prepare-5');
  }, CASE_TIMEOUT_MS);

  /**
   * The parse of the action schema refuses a call with no `repoRoot` before the handler, and a direct handler call refuses it with `INVALID_INPUT`.
   * Neither appends a plane row or writes a blob.
   */
  it('Prepare_NoRepoRoot_IsRefusedAndRecordsNothing', async () => {
    await seed();
    const dispatched = refusalOf(await call({ featureId: STREAM }));
    expect(dispatched.code).toBe('INVALID_INPUT');
    expect(dispatched.message).toContain('repoRoot');

    const direct = await handlePrepare({ featureId: STREAM }, stateDir, callerContext());
    expect(direct.success).toBe(false);
    expect(direct.error?.code).toBe('INVALID_INPUT');
    expect(direct.error?.message).toContain('repoRoot is required');
    expect(await planeRows()).toStrictEqual([]);
    expect(await blobCount()).toBe(0);
  }, CASE_TIMEOUT_MS);

  /**
   * Git resolves a relative path against the server directory, so a relative `repoRoot` is refused.
   * The parse of the action schema refuses it, and the handler refuses it again in a direct call.
   */
  it('Prepare_ARelativeRepoRoot_IsRefusedAndRecordsNothing', async () => {
    await seed();
    const dispatched = refusalOf(await call({ featureId: STREAM, repoRoot: path.basename(repository.checkout) }));
    expect(dispatched.code).toBe('INVALID_INPUT');
    expect(dispatched.message).toContain('absolute');

    const direct = await handlePrepare({ featureId: STREAM, repoRoot: 'checkout/src' }, stateDir, callerContext());
    expect(direct.success).toBe(false);
    expect(direct.error?.code).toBe('INVALID_INPUT');
    expect(direct.error?.message).toContain('is not an absolute path');
    expect(await planeRows()).toStrictEqual([]);
    expect(await blobCount()).toBe(0);
  }, CASE_TIMEOUT_MS);

  /** A directory outside any git work tree has no repository to pin. The refusal names the directory and the recovery. */
  it('Prepare_ARepoRootOutsideGit_IsRefusedAsScopeUnresolved', async () => {
    await seed();
    const outside = canonicalPath(makeTempDir('prepare-scope-outside-'));
    scratchDirs.push(outside);
    const refused = refusalOf(await call({ featureId: STREAM, repoRoot: outside }));
    expect(refused.code).toBe('SCOPE_UNRESOLVED');
    expect(refused.message).toContain(`repoRoot '${outside}' is not inside a git work tree`);
    expect(refused.message).toContain(`Pass as repoRoot the worktree where '${INTEGRATION_BRANCH}' is checked out`);
    expect(await planeRows()).toStrictEqual([]);
    expect(await blobCount()).toBe(0);
  }, CASE_TIMEOUT_MS);

  /** A subdirectory of the checkout pins the root of its work tree, so a call from either directory compiles the same scope. */
  it('Prepare_ASubdirectory_PinsTheRootOfItsWorkTree', async () => {
    await seed();
    const fromSubdirectory = receiptOf(await call({ featureId: STREAM, repoRoot: `${repository.checkout}/src` }));
    expect(fromSubdirectory.capsule.settlementContract.scope?.checkout).toBe(repository.checkout);
    expect(fromSubdirectory.capsule.settlementContract.scope?.repository).toBe(`${repository.checkout}/.git`);

    const fromRoot = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(fromRoot.capsuleVersion).toBe(1);
    expect(await planeRows()).toStrictEqual(['task.assigned', 'task.assigned', 'workflow.prepared']);
  }, CASE_TIMEOUT_MS);
});

describe('prepare pins the commit of the base', () => {
  /** A recorded integration branch that names no commit in the repository refuses before any effect. */
  it('Prepare_ABaseWithNoCommit_IsRefusedAsBaseUnresolved', async () => {
    await seed(READY_PLAN, 'feature/never-created');
    const refused = refusalOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(refused.code).toBe('BASE_UNRESOLVED');
    expect(refused.message).toContain(`'feature/never-created', and the repository of '${repository.checkout}' holds no commit`);
    expect(await planeRows()).toStrictEqual([]);
    expect(await blobCount()).toBe(0);
  }, CASE_TIMEOUT_MS);

  /**
   * The blocker committed its work on its task branch, and its completion row records that commit. The base does not hold it.
   * The refusal names the blocker, the task that waits on it, and both recoveries.
   */
  it('Prepare_ABlockerWhoseCompletionCommitIsNotOnTheBase_IsRefusedAndNamesBothRecoveries', async () => {
    const worktree = await repository.worktreeFor('task-a', { 'src/a.js': 'export const a = 2;\n' });
    const landed = await git(worktree, ['rev-parse', 'HEAD']);
    await seed([
      { id: 'task-a', status: 'complete' },
      { id: 'task-b', status: 'pending', blockedBy: ['task-a'] },
    ]);
    await recordCompletion('task-a', worktree, landed);

    const refused = refusalOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(refused.code).toBe('BASE_UNRESOLVED');
    expect(refused.message).toContain(
      `task 'task-a' is complete, and its landed commit ${landed} is not on '${INTEGRATION_BRANCH}' at ${repository.baseCommit}`,
    );
    expect(refused.message).toContain("'task-b' wait on it");
    expect(refused.message).toContain(`Land 'task-a' on '${INTEGRATION_BRANCH}', then prepare again.`);
    expect(refused.message).toContain('record that landing with a merge.executed row');
    expect(await planeRows()).toStrictEqual([]);
    expect(await blobCount()).toBe(0);
  }, CASE_TIMEOUT_MS);

  /**
   * A squash puts the work of the blocker on the base as a new commit. So the completion commit alone is still not on the base.
   * The row that serialize_merge records for the squash names the new commit, and that commit passes.
   */
  it('Prepare_ABlockerSquashedBySerializeMerge_PassesWhereItsCompletionCommitAloneIsRefused', async () => {
    const worktree = await repository.worktreeFor('task-a', { 'src/a.js': 'export const a = 2;\n' });
    const completed = await git(worktree, ['rev-parse', 'HEAD']);
    await seed([
      { id: 'task-a', status: 'complete' },
      { id: 'task-b', status: 'pending', blockedBy: ['task-a'] },
    ]);
    await recordCompletion('task-a', worktree, completed);
    await git(repository.checkout, ['merge', '-q', '--squash', 'task/task-a']);
    await git(repository.checkout, ['commit', '-q', '-m', 'task-a: the squashed work']);
    const squashed = await git(repository.checkout, ['rev-parse', 'HEAD']);

    const alone = refusalOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(alone.code).toBe('BASE_UNRESOLVED');
    expect(alone.message).toContain(`its landed commit ${completed} is not on '${INTEGRATION_BRANCH}' at ${squashed}`);

    await eventStore.append(STREAM, {
      type: 'merge.executed',
      data: {
        taskId: 'task-a',
        sourceBranch: 'task/task-a',
        targetBranch: INTEGRATION_BRANCH,
        strategy: 'squash',
        mergeSha: squashed,
        rollbackSha: repository.baseCommit,
      },
    });
    const prepared = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(prepared.capsule.settlementContract.taskVerification?.['task-b']?.baseCommit).toBe(squashed);
  }, CASE_TIMEOUT_MS);

  /**
   * A fast-forward puts the completion commit of the first blocker on the base, so a task that waits on it compiles.
   * The second blocker committed on its own branch and did not land. A task that waits on it is refused, and the refusal names that blocker only.
   */
  it('Prepare_ABlockerLandedByAFastForward_PassesAndAnUnlandedBlockerIsRefused', async () => {
    const first = await repository.worktreeFor('task-a', { 'src/a.js': 'export const a = 2;\n' });
    const second = await repository.worktreeFor('task-b', { 'src/b.js': 'export const b = 2;\n' });
    const firstCommit = await git(first, ['rev-parse', 'HEAD']);
    const secondCommit = await git(second, ['rev-parse', 'HEAD']);
    await git(repository.checkout, ['merge', '-q', '--ff-only', 'task/task-a']);
    await seed([
      { id: 'task-a', status: 'complete' },
      { id: 'task-b', status: 'complete' },
      { id: 'task-c', status: 'pending', blockedBy: ['task-a'] },
    ]);
    await recordCompletion('task-a', first, firstCommit);
    await recordCompletion('task-b', second, secondCommit);

    const landed = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(landed.capsule.graph.tasks.map((task) => task.taskId)).toStrictEqual(['task-c']);
    expect(landed.capsule.settlementContract.taskVerification?.['task-c']?.baseCommit).toBe(firstCommit);

    await replan([
      { id: 'task-a', status: 'complete' },
      { id: 'task-b', status: 'complete' },
      { id: 'task-c', status: 'pending', blockedBy: ['task-a'] },
      { id: 'task-d', status: 'pending', blockedBy: ['task-b'] },
    ]);
    const refused = refusalOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(refused.code).toBe('BASE_UNRESOLVED');
    expect(refused.message).toContain(`task 'task-b' is complete, and its landed commit ${secondCommit} is not on`);
    expect(refused.message).not.toContain("task 'task-a'");
    expect(await planeRows()).toStrictEqual(['task.assigned', 'workflow.prepared']);
  }, CASE_TIMEOUT_MS);

  /**
   * The first blocker has no completion row, as when a person sets its status. The second has a completion row of an earlier build, with no commit.
   * Neither is checked, and the capsule pins the commit of the base.
   */
  it('Prepare_ABlockerWithNoRecordedCommit_CompilesWithTheBaseCommitPinned', async () => {
    const worktree = await repository.worktreeFor('task-b');
    await seed([
      { id: 'task-a', status: 'complete' },
      { id: 'task-b', status: 'complete' },
      { id: 'task-c', status: 'pending', blockedBy: ['task-a', 'task-b'] },
    ]);
    await eventStore.append(STREAM, { type: 'task.completed', data: { taskId: 'task-b', worktreePath: worktree, verified: false } });

    const receipt = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(receipt.capsule.settlementContract.taskVerification).toStrictEqual({
      'task-c': { riskTier: 'low', boundaryTouching: false, baseRef: INTEGRATION_BRANCH, baseCommit: repository.baseCommit },
    });
  }, CASE_TIMEOUT_MS);

  /**
   * A retry with the base where it was replays the recorded capsule.
   * A commit on the base moves its commit, which is a compile input. So the next call compiles the next capsule version with the new commit.
   */
  it('Prepare_AMovedBase_CompilesTheNextCapsuleVersion', async () => {
    await seed();
    const first = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout })).capsuleVersion).toBe(1);

    await git(repository.checkout, ['commit', '-q', '--allow-empty', '-m', 'the base moves']);
    const moved = await git(repository.checkout, ['rev-parse', 'HEAD']);
    expect(moved).not.toBe(repository.baseCommit);

    const next = receiptOf(await call({ featureId: STREAM, repoRoot: repository.checkout }));
    expect(next.capsuleVersion).toBe(2);
    expect(first.capsule.settlementContract.taskVerification?.['task-a']?.baseCommit).toBe(repository.baseCommit);
    expect(next.capsule.settlementContract.taskVerification?.['task-a']?.baseCommit).toBe(moved);
    expect((await planeRows()).filter((type) => type === 'workflow.prepared')).toHaveLength(2);
  }, CASE_TIMEOUT_MS);
});
