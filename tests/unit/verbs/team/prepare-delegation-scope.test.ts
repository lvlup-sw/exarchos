/**
 * Tests that `prepare_delegation` reads the repository of the caller.
 *
 * The git guards, the stash probe and the read of a relative `planPath` run in `repoRoot`. A call with no `repoRoot`
 * keeps the server directory and warns. A relative `repoRoot` is refused before any git call, and nothing is recorded.
 * Each case sets the process directory to a temporary repository, which acts as the server directory.
 * The mock replaces only `assertMainWorktree`, because a run under `.claude/worktrees/` fails the real guard.
 * The other guards run on real git, in temporary repositories.
 *
 * @oracle-sources: ../../../../src/verbs/team/prepare-delegation.ts, the rows of the real store after each call, and the branches that each temporary repository holds
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { handlePrepareDelegation } from '../../../../src/verbs/team/prepare-delegation.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

vi.mock('../../../../src/verbs/team/dispatch-guard.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/verbs/team/dispatch-guard.js')>();
  return {
    ...actual,
    assertMainWorktree: vi.fn().mockReturnValue({
      isMain: true,
      actual: '/repo',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    }),
  };
});

/** The budget of each case. Each case spawns a few git commands in temporary repositories. */
const CASE_TIMEOUT_MS = 30_000;

/** The branch of a feature tree. It is not protected, and it descends from `main`. */
const FEATURE = 'feature/scope';

/** The text of the warning of a call with no `repoRoot`. */
const SERVER_DIRECTORY_WARNING = /^repoRoot absent: .*read the server directory/;

/** Each directory that a case made. The teardown deletes each one. */
let made: string[] = [];

/** The state directory and the store of the case. */
let stateDir: string;
let store: EventStore;

beforeEach(() => {
  resetMaterializerCache();
  stateDir = makeTempDir('prep-deleg-scope-state-');
  made = [stateDir];
  store = new EventStore(stateDir);
});

afterEach(async () => {
  resetMaterializerCache();
  for (const dir of made) await rmrfAsync(dir);
});

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).trim();
}

/** Writes one file under the root of a tree, and makes its directory first. */
async function writeTreeFile(root: string, file: string, text: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf-8');
}

/**
 * Makes a repository with one commit on `main`. With a branch, the repository then holds a new branch at that commit.
 * The teardown deletes the repository.
 */
async function repository(label: string, branch?: string): Promise<string> {
  const dir = makeTempDir(`prep-deleg-scope-${label}-`);
  made.push(dir);
  await git(dir, ['init', '-q', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeTreeFile(dir, 'README.md', `the ${label} repository\n`);
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-q', '-m', 'the first commit']);
  if (branch !== undefined) await git(dir, ['switch', '-q', '-c', branch]);
  return dir;
}

/** Leaves one entry in the stash of a repository. */
async function stashAnEdit(dir: string): Promise<void> {
  await writeTreeFile(dir, 'README.md', 'an edit to stash\n');
  await git(dir, ['stash', 'push', '-q', '-m', 'work of another agent']);
}

/** Runs `fn` with the process directory set to the server directory, then puts the prior directory back. */
async function inServerDirectory<T>(serverDirectory: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  process.chdir(serverDirectory);
  try {
    return await fn();
  } finally {
    process.chdir(prior);
  }
}

/** The dispatch context of the case, over its real store. */
function context(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** The data of a result as a record. A result with no data gives an empty record. */
function dataOf(result: ToolResult): Record<string, unknown> {
  const data: unknown = result.data;
  return typeof data === 'object' && data !== null ? { ...data } : {};
}

/** The protected-branch outcome of the one `dispatch.preflight` row of a stream. */
async function protectedBranchPassed(streamId: string): Promise<unknown> {
  const rows = await store.query(streamId, { type: 'dispatch.preflight' });
  expect(rows).toHaveLength(1);
  const data: unknown = rows[0]?.data;
  if (typeof data !== 'object' || data === null || !('guards' in data)) return undefined;
  const guards: unknown = data.guards;
  if (typeof guards !== 'object' || guards === null || !('protectedBranch' in guards)) return undefined;
  const outcome: unknown = guards.protectedBranch;
  return typeof outcome === 'object' && outcome !== null && 'passed' in outcome ? outcome.passed : undefined;
}

/** The `worktreePath` of each `stash.detected` row of a stream. */
async function stashRowPaths(streamId: string): Promise<unknown[]> {
  const rows = await store.query(streamId, { type: 'stash.detected' });
  return rows.map((row) => {
    const data: unknown = row.data;
    return typeof data === 'object' && data !== null && 'worktreePath' in data ? data.worktreePath : undefined;
  });
}

/**
 * Seeds a stream that the readiness view reports as ready for the tasks: an approved plan, and a worktree for each task.
 * Only a ready call classifies its tasks.
 */
async function seedReadyStream(streamId: string, taskIds: readonly string[]): Promise<void> {
  await store.append(streamId, { type: 'workflow.transition', data: { to: 'plan-review' } });
  await store.append(streamId, { type: 'state.patched', data: { patch: { 'artifacts.plan': 'plan.md' } } });
  for (const taskId of taskIds) {
    await store.append(streamId, { type: 'task.assigned', data: { taskId } });
  }
  for (const taskId of taskIds) {
    await store.append(streamId, { type: 'worktree.created', data: { taskId, worktreePath: `/w/${taskId}` } });
  }
}

describe('prepare_delegation reads the repository of the caller', () => {
  /** The server tree is on `main`. The tree of the caller is on a feature branch, so the guard reads a branch that is not protected. */
  it('PrepareDelegation_AServerOnMainAndARepoRootOnAFeatureWorktree_IsNotBlockedAsProtected', async () => {
    const server = await repository('server-on-main');
    const caller = await repository('caller-on-feature', FEATURE);
    const streamId = 'scope-server-on-main';

    const result = await inServerDirectory(server, () =>
      handlePrepareDelegation({ featureId: streamId, repoRoot: caller }, stateDir, context()),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.reason).not.toBe('current-branch-protected');
    expect(data.blocked).not.toBe(true);
    expect(data.baseBranch).toBe(FEATURE);
    expect(await protectedBranchPassed(streamId)).toBe(true);
  }, CASE_TIMEOUT_MS);

  /** The server tree is on a feature branch. The tree of the caller is on `main`, so the guard blocks the call. */
  it('PrepareDelegation_AServerOnAFeatureWorktreeAndARepoRootOnMain_IsBlockedAsProtected', async () => {
    const server = await repository('server-on-feature', FEATURE);
    const caller = await repository('caller-on-main');
    const streamId = 'scope-caller-on-main';

    const result = await inServerDirectory(server, () =>
      handlePrepareDelegation({ featureId: streamId, repoRoot: caller }, stateDir, context()),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');
    expect(data.currentBranch).toBe('main');
    expect(await protectedBranchPassed(streamId)).toBe(false);
  }, CASE_TIMEOUT_MS);

  /**
   * In the tree of the caller, `main` gains a commit after the feature branch forks, so `main` is not an ancestor of it.
   * In the server tree, the same branch descends from `main`.
   */
  it('PrepareDelegation_TheAncestryPreflight_ReadsRepoRoot', async () => {
    const server = await repository('server-ancestry', FEATURE);
    const caller = await repository('caller-ancestry', FEATURE);
    await git(caller, ['switch', '-q', 'main']);
    await writeTreeFile(caller, 'later.md', 'a commit of main after the fork\n');
    await git(caller, ['add', 'later.md']);
    await git(caller, ['commit', '-q', '-m', 'a later commit of main']);
    await git(caller, ['switch', '-q', FEATURE]);
    const streamId = 'scope-ancestry';

    const result = await inServerDirectory(server, () =>
      handlePrepareDelegation({ featureId: streamId, repoRoot: caller }, stateDir, context()),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('ancestry');
    expect(data.missing).toEqual(['main']);
  }, CASE_TIMEOUT_MS);

  /** Only the tree of the caller holds a stash entry. The row names that tree. */
  it('PrepareDelegation_TheStashProbe_ReadsRepoRoot', async () => {
    const server = await repository('server-stash', FEATURE);
    const caller = await repository('caller-stash', FEATURE);
    await stashAnEdit(caller);
    const streamId = 'scope-stash';

    const result = await inServerDirectory(server, () =>
      handlePrepareDelegation({ featureId: streamId, repoRoot: caller }, stateDir, context()),
    );

    expect(result.success).toBe(true);
    expect(dataOf(result).blocked).not.toBe(true);
    expect(await stashRowPaths(streamId)).toEqual([caller]);
    expect((result.warnings ?? []).some((w) => SERVER_DIRECTORY_WARNING.test(w))).toBe(false);
  }, CASE_TIMEOUT_MS);

  /** The server tree holds a stash entry. With no `repoRoot`, the probe reads that tree and the result names it in a warning. */
  it('PrepareDelegation_NoRepoRoot_KeepsTheServerDirectoryAndWarns', async () => {
    const server = await repository('server-no-repo-root', FEATURE);
    await stashAnEdit(server);
    const streamId = 'scope-no-repo-root';

    const { result, serverDirectory } = await inServerDirectory(server, async () => ({
      result: await handlePrepareDelegation({ featureId: streamId }, stateDir, context()),
      serverDirectory: process.cwd(),
    }));

    expect(result.success).toBe(true);
    expect(await stashRowPaths(streamId)).toEqual([serverDirectory]);
    const warnings = (result.warnings ?? []).filter((w) => SERVER_DIRECTORY_WARNING.test(w));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(serverDirectory);
  }, CASE_TIMEOUT_MS);

  /**
   * The plan exists under `repoRoot` with a risk stamp, and not under the server directory.
   * The stamp is high and boundary-touching, and the heuristic for the task gives medium and no boundary.
   */
  it('PrepareDelegation_ARelativePlanPath_ResolvesAgainstRepoRoot', async () => {
    const server = await repository('server-plan', FEATURE);
    const caller = await repository('caller-plan', FEATURE);
    const planPath = 'docs/specs/scope-plan.md';
    await writeTreeFile(
      caller,
      planPath,
      '#### Task T-1: Reshape the widget\n**Risk Tier:** high · **Boundary Touching:** true\n',
    );
    const streamId = 'scope-plan';
    await seedReadyStream(streamId, ['T-1']);

    const result = await inServerDirectory(server, () =>
      handlePrepareDelegation(
        { featureId: streamId, repoRoot: caller, planPath, tasks: [{ id: 'T-1', title: 'Reshape the widget' }] },
        stateDir,
        context(),
      ),
    );

    expect(result.success).toBe(true);
    expect((result.warnings ?? []).some((w) => w.startsWith('planPath unreadable'))).toBe(false);
    const data = dataOf(result);
    expect(data.ready).toBe(true);
    expect(data.taskClassifications).toEqual([
      expect.objectContaining({ taskId: 'T-1', riskTier: 'high', boundaryTouching: true }),
    ]);
  }, CASE_TIMEOUT_MS);

  /**
   * The server tree is on `main`, so a git read there blocks the call and records rows.
   * The handler refuses the relative path first, through dispatch and in a direct call.
   * The dispatch call runs as the local operator, as the CLI does, so admission lets it reach the handler.
   */
  it('PrepareDelegation_ARelativeRepoRoot_IsRefusedAndRecordsNothing', async () => {
    const server = await repository('server-relative');
    const viaDispatch = 'scope-relative-dispatch';
    const direct = 'scope-relative-direct';

    const { dispatched, called } = await inServerDirectory(server, async () => ({
      dispatched: await dispatch(
        'exarchos_orchestrate',
        { action: 'prepare_delegation', featureId: viaDispatch, repoRoot: 'relative/tree' },
        { ...context(), callerIdentity: deriveLocalOperatorIdentity(stateDir) },
      ),
      called: await handlePrepareDelegation({ featureId: direct, repoRoot: 'relative/tree' }, stateDir, context()),
    }));

    for (const result of [dispatched, called]) {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('repoRoot');
      expect(result.error?.message).toContain('not an absolute path');
    }
    expect(await store.query(viaDispatch)).toEqual([]);
    expect(await store.query(direct)).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
