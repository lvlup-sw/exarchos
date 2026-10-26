/**
 * `task_complete` judges the named tree against the scope that the reference capsule pins, on real git.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver. Telemetry is at its shipped default,
 * and the context sets no observer of a named tree, so the completion leaf observes each tree with git. Each workflow is seeded
 * as rows of the event store only, so no case writes a state document. `prepare` pins the scope from a real checkout.
 * `check_static_analysis` passes on the green fixture of the tree that the completion names.
 * Each case spawns git and npm, so it sets its own timeout and does not raise the budget of its tier.
 *
 * @oracle-sources: ../../src/verbs/tasks/tools.ts, the replies of each dispatched call, the rows of the real event store, and the trees that real git reports in each case
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type FixtureFiles, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-task-complete-scope-acceptance';
const INTEGRATION_BRANCH = 'feature/task-complete-scope';
/** The budget of one case. A case spawns git and runs the static-analysis gate at most twice. */
const CASE_TIMEOUT_MS = 120_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script: the cheapest process that exits 0. */
const OK = 'node -e ""';

/** The green fixture: a Node project whose static-analysis scripts each exit 0. */
const GREEN_PROJECT: FixtureFiles = {
  'package.json': JSON.stringify(
    {
      name: 'task-complete-scope-fixture',
      version: '1.0.0',
      private: true,
      scripts: { lint: OK, typecheck: OK, 'quality-check': OK },
    },
    null,
    2,
  ),
};

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'task-complete-scope-acceptance-'));
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
 * The dispatch context of an agent, as the composition root builds it. It sets no observer of a named tree, so the
 * completion leaf observes each tree with git. Telemetry is at its shipped default.
 */
function withShippedObserver(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'task-complete-scope-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

async function call(action: string, args: Record<string, unknown>): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch('exarchos_orchestrate', { action, ...args }, withShippedObserver()));
}

/** The fields of a prepare reply that the cases read. */
const PreparedView = z.object({
  capsuleVersion: z.number().int(),
  capsule: z.object({
    settlementContract: z.object({ scope: z.object({ repository: z.string(), checkout: z.string() }) }),
  }),
});

/** The fields of a completed row that the cases read. */
const CompletedRow = z.object({ taskId: z.string(), worktreePath: z.string().optional(), commit: z.string().optional() });

/** The rows of a plan: each task is ready, low-risk and off the boundary. */
function planRows(taskIds: readonly string[]): Record<string, unknown>[] {
  return taskIds.map((id) => ({ id, title: id, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }));
}

/** Seeds a feature workflow in `delegate` with the given ready tasks, and prepares it from `repoRoot`. */
async function prepareFrom(
  repoRoot: string,
  taskIds: readonly string[],
): Promise<{ readonly capsuleVersion: number; readonly scope: { readonly repository: string; readonly checkout: string } }> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks: planRows(taskIds) } },
  });
  const prepared = await call('prepare', { featureId: STREAM, repoRoot });
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  const reply = PreparedView.parse(prepared.data);
  return { capsuleVersion: reply.capsuleVersion, scope: reply.capsule.settlementContract.scope };
}

/** Runs the real static-analysis gate of the task on a tree, as the runbook step does, and expects a pass. */
async function passOn(taskId: string, tree: string): Promise<void> {
  const gate = await call('check_static_analysis', { featureId: STREAM, taskId, repoRoot: 'auto', worktreePath: tree });
  expect(gate.success, JSON.stringify(gate)).toBe(true);
  expect(z.object({ passed: z.boolean() }).parse(gate.data).passed, JSON.stringify(gate.data)).toBe(true);
}

/** Calls `task_complete` for the task, with the capsule version of its batch and the tree that it names. */
async function completeOn(taskId: string, tree: string, capsuleVersion: number): Promise<CallResult> {
  return call('task_complete', { featureId: STREAM, taskId, capsuleVersion, result: { worktreePath: tree } });
}

/** The completed rows of the stream. */
async function completedRows(): Promise<z.infer<typeof CompletedRow>[]> {
  return (await eventStore.query(STREAM, { type: 'task.completed' })).map((row) => CompletedRow.parse(row.data));
}

/**
 * Checks a refusal with `tree-out-of-scope` and the rule, and returns its message.
 * No completion row names the task.
 */
async function refusedOutOfScope(result: CallResult, taskId: string, rule: string): Promise<string> {
  expect(result.success, JSON.stringify(result)).toBe(false);
  expect(result.error?.code).toBe('GATE_NOT_PASSED');
  const message = result.error?.message ?? '';
  expect(message).toContain(`the scope rule ${rule} of capsule v`);
  expect(message).toContain('so the cause is tree-out-of-scope');
  expect(message).toContain('Fork a worktree of the pinned repository');
  expect((await completedRows()).map((row) => row.taskId)).not.toContain(taskId);
  return message;
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

describe('task_complete judges the named tree against the pinned scope on real git', () => {
  /** A pass on the checkout that prepare read, and a completion that names the checkout, complete no task there. */
  it('TaskCompleteScope_APassOnTheCheckoutThatNamesTheCheckout_IsRefusedAsTheCheckout', async () => {
    const { capsuleVersion, scope } = await prepareFrom(repository.checkout, ['task-a']);
    expect(scope.checkout).toBe(repository.checkout);
    await passOn('task-a', repository.checkout);

    const result = await completeOn('task-a', repository.checkout, capsuleVersion);

    const message = await refusedOutOfScope(result, 'task-a', 'the-checkout');
    expect(message).toContain('it is the checkout that prepare read');
    expect(message).toContain(`The capsule pins the repository '${scope.repository}'`);
    expect(message).toContain(`from '${INTEGRATION_BRANCH}' at ${repository.baseCommit}`);
  }, CASE_TIMEOUT_MS);

  /**
   * The checkout is a linked worktree that holds the base branch, and the base branch holds no commit beyond `main`.
   * The primary worktree on `main` holds the base commit and is not on the base branch. A pass there is still refused.
   */
  it('TaskCompleteScope_APassOnThePrimaryWorktree_IsRefusedAsTheCheckout', async () => {
    const { primary, linked } = await repository.baseInLinkedWorktree();
    const { capsuleVersion, scope } = await prepareFrom(linked, ['task-a']);
    expect(scope).toEqual({ repository: `${primary}/.git`, checkout: linked });
    expect(await git(primary, ['rev-parse', 'HEAD'])).toBe(repository.baseCommit);
    await passOn('task-a', primary);

    const result = await completeOn('task-a', primary, capsuleVersion);

    const message = await refusedOutOfScope(result, 'task-a', 'the-checkout');
    expect(message).toContain('it is the primary worktree of the repository');
  }, CASE_TIMEOUT_MS);

  /** The checkout is the primary worktree on `main`, and the completion names the linked worktree that holds the base branch. */
  it('TaskCompleteScope_APassOnALinkedWorktreeOfTheBaseBranch_IsRefusedAsOnTheBaseBranch', async () => {
    const { primary, linked } = await repository.baseInLinkedWorktree();
    const { capsuleVersion, scope } = await prepareFrom(primary, ['task-a']);
    expect(scope.checkout).toBe(primary);
    expect(await git(linked, ['symbolic-ref', '--short', 'HEAD'])).toBe(INTEGRATION_BRANCH);
    await passOn('task-a', linked);

    const result = await completeOn('task-a', linked, capsuleVersion);

    const message = await refusedOutOfScope(result, 'task-a', 'on-the-base-branch');
    expect(message).toContain(`it is on the base branch "${INTEGRATION_BRANCH}"`);
  }, CASE_TIMEOUT_MS);

  /** A linked worktree of another repository is not a worktree of the pinned repository. */
  it('TaskCompleteScope_APassOnAnotherRepository_IsRefusedAsOtherRepository', async () => {
    const other = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: GREEN_PROJECT });
    scratchDirs.push(other.root);
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    const tree = await other.worktreeFor('task-a');
    await passOn('task-a', tree);

    const result = await completeOn('task-a', tree, capsuleVersion);

    const message = await refusedOutOfScope(result, 'task-a', 'other-repository');
    expect(message).toContain(JSON.stringify(`${other.checkout}/.git`));
  }, CASE_TIMEOUT_MS);

  /**
   * The integration branch gets a commit beyond `main` before prepare, and a linked worktree forks from `main`.
   * That worktree does not hold the base commit that the capsule pins.
   */
  it('TaskCompleteScope_AWorktreeThatDoesNotHoldTheBase_IsRefusedAsBaseNotHeld', async () => {
    await git(repository.checkout, ['commit', '-q', '--allow-empty', '-m', 'the integration branch moves beyond main']);
    const forked = path.join(repository.root, 'task-a-from-main');
    await git(repository.checkout, ['worktree', 'add', '-q', '-b', 'task-a-from-main', forked, 'main']);
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    const baseCommit = await git(repository.checkout, ['rev-parse', 'HEAD']);
    expect(baseCommit).not.toBe(repository.baseCommit);
    const tree = await git(forked, ['rev-parse', '--show-toplevel']);
    await passOn('task-a', tree);

    const result = await completeOn('task-a', tree, capsuleVersion);

    const message = await refusedOutOfScope(result, 'task-a', 'base-not-held');
    expect(message).toContain(`its HEAD does not hold the base commit ${baseCommit} of "${INTEGRATION_BRANCH}"`);
  }, CASE_TIMEOUT_MS);

  /**
   * Task S completes on its worktree W. Then a pass of task T on W, and a completion of T that names W, are refused.
   * W is a linked worktree on its own branch that holds the base, so only the completion row of S refuses it.
   */
  it('TaskCompleteScope_APassOnTheWorktreeOfACompletedTask_IsRefusedAsSharedWorktree', async () => {
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-s', 'task-t']);
    const worktree = await repository.worktreeFor('task-s');
    await passOn('task-s', worktree);
    const first = await completeOn('task-s', worktree, capsuleVersion);
    expect(first.success, JSON.stringify(first)).toBe(true);
    await passOn('task-t', worktree);

    const result = await completeOn('task-t', worktree, capsuleVersion);

    const message = await refusedOutOfScope(result, 'task-t', 'shared-worktree');
    expect(message).toContain('the completion of task "task-s" names it too');
    expect((await completedRows()).map((row) => row.taskId)).toEqual(['task-s']);
  }, CASE_TIMEOUT_MS);

  /**
   * The leaf with the shipped observer. A pass on the checkout of the repository is refused first.
   * Then a pass on a linked worktree of the task at its head completes the task, and the row names that tree and its head.
   */
  it('TaskCompleteScope_AnInScopeWorktreeAtItsHead_CompletesWhereTheCheckoutIsRefused', async () => {
    const { capsuleVersion } = await prepareFrom(repository.checkout, ['task-a']);
    await passOn('task-a', repository.checkout);
    const refused = await completeOn('task-a', repository.checkout, capsuleVersion);
    await refusedOutOfScope(refused, 'task-a', 'the-checkout');

    const worktree = await repository.worktreeFor('task-a', { 'src/work.js': 'export const work = 1;\n' });
    await passOn('task-a', worktree);
    const completed = await completeOn('task-a', worktree, capsuleVersion);

    expect(completed.success, JSON.stringify(completed)).toBe(true);
    expect(await completedRows()).toEqual([
      { taskId: 'task-a', worktreePath: worktree, commit: await git(worktree, ['rev-parse', 'HEAD']) },
    ]);
  }, CASE_TIMEOUT_MS);
});
