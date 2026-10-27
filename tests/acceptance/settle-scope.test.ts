/**
 * `settle` checks each claimed worktree against the scope that the capsule pins, before any gate runs.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver. Telemetry is at its shipped
 * default, and the observer of a claimed worktree is the shipped one, which runs real git. Each workflow is seeded as
 * rows of the event store only, so no case writes a state document. The repository of each case comes from the scoped
 * repository helper, and the static-analysis gate passes on its green fixture.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 *
 * @oracle-sources: ../../src/verbs/settle/settle-scope.ts, the receipts of each dispatched call, the rows of the real event store, and the trees that real git reports in each case
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { canonicalPath } from '../../src/utils/git-tree.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type FixtureFiles, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-settle-scope-acceptance';
const INTEGRATION_BRANCH = 'feature/settle-scope';
/** The budget of one case. A case spawns git and runs the static-analysis gate of at most one task. */
const CASE_TIMEOUT_MS = 90_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script: the cheapest process that exits 0. */
const OK = 'node -e ""';

/** The green fixture: a Node project whose static-analysis scripts each exit 0. */
const GREEN_PROJECT: FixtureFiles = {
  'package.json': JSON.stringify(
    { name: 'settle-scope-fixture', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
    null,
    2,
  ),
};

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-scope-acceptance-'));
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

/**
 * The dispatch context of an agent, as the composition root builds it. It sets no observer of a claimed worktree,
 * so settle observes each claimed worktree with git. Telemetry is at its shipped default.
 */
function withShippedTreeObserver(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'settle-scope-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

async function call(action: string, args: Record<string, unknown>, context: DispatchContext): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch('exarchos_orchestrate', { action, ...args }, context));
}

/** The fields of a prepare receipt that the cases read. */
const PreparedView = z.object({
  capsuleVersion: z.number().int(),
  capsule: z.object({
    settlementContract: z.object({ scope: z.object({ repository: z.string(), checkout: z.string() }) }),
  }),
});

/** The fields of a settle receipt that the cases read. */
const SettledView = z.object({
  outcome: z.string(),
  acceptedTasks: z.array(z.string()),
  unresolved: z.array(z.object({ taskId: z.string(), cause: z.string() })).optional(),
  findings: z.array(z.object({ kind: z.string(), subject: z.string(), message: z.string() })),
  verification: z.array(z.object({ taskId: z.string(), outcome: z.string() })).optional(),
});

type Settled = z.infer<typeof SettledView>;

/** The rows of a plan: each task is ready, low-risk and off the boundary, so static analysis is the whole ladder. */
function planRows(taskIds: readonly string[]): Record<string, unknown>[] {
  return taskIds.map((id) => ({ id, title: id, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }));
}

/** A feature workflow in `delegate` with the given ready tasks, as rows of the event store only. */
async function seed(taskIds: readonly string[]): Promise<void> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks: planRows(taskIds) } },
  });
}

/** Seeds the workflow and prepares it from `repoRoot`. It returns the capsule version and the pinned scope. */
async function prepareFrom(
  repoRoot: string,
  taskIds: readonly string[],
): Promise<{ readonly capsuleVersion: number; readonly scope: { readonly repository: string; readonly checkout: string } }> {
  await seed(taskIds);
  const prepared = await call('prepare', { featureId: STREAM, repoRoot }, withShippedTreeObserver());
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  const receipt = PreparedView.parse(prepared.data);
  return { capsuleVersion: receipt.capsuleVersion, scope: receipt.capsule.settlementContract.scope };
}

/** A completed claim on a worktree, with the given result fields beside the path. */
function claimOn(taskId: string, worktreePath: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { taskId, fields: { worktreePath, ...fields }, evidence: [] };
}

/** One settle call of a batch, and its receipt. */
async function settle(
  capsuleVersion: number,
  claims: readonly Record<string, unknown>[],
  context: DispatchContext = withShippedTreeObserver(),
): Promise<Settled> {
  const settled = await call('settle', { featureId: STREAM, capsuleVersion, batchId: 'batch-scope', claims }, context);
  expect(settled.success, JSON.stringify(settled)).toBe(true);
  return SettledView.parse(settled.data);
}

/** The task that each `gate.executed` row of the stream names. A row that names no task gives nothing. */
async function tasksWithGateRows(): Promise<string[]> {
  const tasks: string[] = [];
  for (const row of await eventStore.query(STREAM, { type: 'gate.executed' })) {
    const parsed = z.object({ details: z.object({ taskId: z.string() }) }).safeParse(row.data);
    if (parsed.success) tasks.push(parsed.data.details.taskId);
  }
  return tasks;
}

/** The tasks that the stream records complete. */
async function completedTasks(): Promise<string[]> {
  const rows = await eventStore.query(STREAM, { type: 'task.completed' });
  return rows.map((row) => z.object({ taskId: z.string() }).parse(row.data).taskId);
}

/**
 * Checks the receipt of a batch whose one task is unresolved before verification. The task is not accepted, and the
 * finding names the cause and the recovery. No gate row and no completion row names the task.
 * It returns the message of the finding.
 */
async function unresolvedBeforeVerification(receipt: Settled, taskId: string, cause: string): Promise<string> {
  expect(receipt.outcome).toBe('corrective-capsule');
  expect(receipt.acceptedTasks).toEqual([]);
  expect(receipt.unresolved).toEqual([{ taskId, cause: 'worktree-out-of-scope' }]);
  expect(receipt.findings.map((finding) => [finding.kind, finding.subject])).toEqual([['worktree-out-of-scope', taskId]]);
  const message = receipt.findings[0]?.message ?? '';
  expect(message).toContain(`(${cause})`);
  expect(message).toContain('claim the task in a new batch');
  expect(receipt.verification ?? []).toEqual([]);
  expect(await tasksWithGateRows()).not.toContain(taskId);
  expect(await completedTasks()).toEqual([]);
  return message;
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

describe('settle checks each claimed worktree against the pinned scope', () => {
  /** A linked worktree of another repository is not a worktree of the pinned repository. */
  it('SettleScope_AClaimInAnotherRepository_IsUnresolvedBeforeVerification', async () => {
    const other = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: GREEN_PROJECT });
    scratchDirs.push(other.root);
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    const receipt = await settle(capsuleVersion, [claimOn('task-a', await other.worktreeFor('task-a'))]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'other-repository');
    expect(message).toContain(JSON.stringify(`${other.checkout}/.git`));
  }, CASE_TIMEOUT_MS);

  /** A directory outside any git work tree is not the root of a worktree. */
  it('SettleScope_AClaimOutsideAnyRepository_IsUnresolvedBeforeVerification', async () => {
    const outside = canonicalPath(makeTempDir('settle-scope-outside-'));
    scratchDirs.push(outside);
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    const receipt = await settle(capsuleVersion, [claimOn('task-a', outside)]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'not-a-worktree-root');
    expect(message).toContain('outside any git work tree');
  }, CASE_TIMEOUT_MS);

  /** The checkout that prepare read holds the work of no task. */
  it('SettleScope_AClaimOnTheCheckout_IsUnresolved', async () => {
    const { capsuleVersion, scope } = await prepareFrom(repository.checkout, ['task-a']);
    expect(scope.checkout).toBe(repository.checkout);
    const receipt = await settle(capsuleVersion, [claimOn('task-a', repository.checkout)]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'the-checkout');
    expect(message).toContain('the checkout that prepare read');
  }, CASE_TIMEOUT_MS);

  /**
   * The checkout is the primary worktree on `main`, and a linked worktree holds the base branch. That linked worktree is
   * neither the checkout nor the primary worktree, and it is on the base branch.
   */
  it('SettleScope_ALinkedWorktreeOfTheBaseBranchThatIsNotTheCheckout_IsUnresolvedAsOnTheBaseBranch', async () => {
    const { primary, linked } = await repository.baseInLinkedWorktree();
    const { capsuleVersion, scope } = await prepareFrom(primary, ['task-a']);
    expect(scope.checkout).toBe(primary);
    expect(await git(linked, ['symbolic-ref', '--short', 'HEAD'])).toBe(INTEGRATION_BRANCH);
    const receipt = await settle(capsuleVersion, [claimOn('task-a', linked)]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'on-the-base-branch');
    expect(message).toContain(JSON.stringify(INTEGRATION_BRANCH));
  }, CASE_TIMEOUT_MS);

  /**
   * The checkout is a linked worktree that holds the base branch, and the base branch holds no commit beyond `main`.
   * The primary worktree on `main` is clean, holds the base commit and is not on the base branch. It is still refused.
   */
  it('SettleScope_ThePrimaryWorktree_IsUnresolvedAsTheCheckout', async () => {
    const { primary, linked } = await repository.baseInLinkedWorktree();
    const { capsuleVersion, scope } = await prepareFrom(linked, ['task-a']);
    expect(scope).toEqual({ repository: `${primary}/.git`, checkout: linked });
    expect(await git(primary, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await git(primary, ['rev-parse', 'HEAD'])).toBe(repository.baseCommit);
    expect(await git(primary, ['status', '--porcelain'])).toBe('');
    const receipt = await settle(capsuleVersion, [claimOn('task-a', primary)]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'the-checkout');
    expect(message).toContain('the primary worktree of the repository');
  }, CASE_TIMEOUT_MS);

  /** A claim that names a branch names the branch of its worktree. */
  it('SettleScope_ABranchThatDiffersFromTheClaim_IsUnresolved', async () => {
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    const worktree = await repository.worktreeFor('task-a');
    const receipt = await settle(capsuleVersion, [claimOn('task-a', worktree, { branch: 'task/another' })]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'other-branch');
    expect(message).toContain('"task/another"');
    expect(message).toContain('"task/task-a"');
  }, CASE_TIMEOUT_MS);

  /** A file that git does not ignore and that the task did not commit leaves the tree dirty. The finding names the file. */
  it('SettleScope_AnUntrackedFile_IsUnresolvedAndNamed', async () => {
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    const worktree = await repository.worktreeFor('task-a');
    await writeFile(path.join(worktree, 'notes.txt'), 'not committed\n', 'utf-8');
    const receipt = await settle(capsuleVersion, [claimOn('task-a', worktree)]);
    const message = await unresolvedBeforeVerification(receipt, 'task-a', 'uncommitted-changes');
    expect(message).toContain('git status lists "notes.txt"');
    expect(message).toContain('Commit the listed files of the task');
  }, CASE_TIMEOUT_MS);

  /**
   * The twin of the observer seam. The case keeps the observer that the composition root ships.
   * A claim on a linked worktree of its own verifies and completes its task. A claim on the checkout is unresolved and runs no gate.
   */
  it('SettleScope_AnInScopeWorktreeAndAnOutOfScopeWorktree_VerifyOnlyTheFirst', async () => {
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a', 'task-b']);
    const worktree = await repository.worktreeFor('task-a');
    const receipt = await settle(
      capsuleVersion,
      [claimOn('task-a', worktree), claimOn('task-b', repository.checkout)],
      withShippedTreeObserver(),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual(['task-a']);
    expect(receipt.verification).toEqual([{ taskId: 'task-a', outcome: 'verified' }]);
    expect(receipt.unresolved).toEqual([{ taskId: 'task-b', cause: 'worktree-out-of-scope' }]);
    expect(receipt.findings[0]?.message).toContain('(the-checkout)');
    expect(await completedTasks()).toEqual(['task-a']);
    const gated = await tasksWithGateRows();
    expect(gated).toContain('task-a');
    expect(gated).not.toContain('task-b');
  }, CASE_TIMEOUT_MS);
});
