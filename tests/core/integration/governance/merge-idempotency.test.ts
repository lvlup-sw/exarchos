// Duplicate merge is prevented through the shipped path.
//
// A test with a mock `vcsMerge` counts mock calls. It cannot count merge
// commits. The test in this file runs the production call path and asserts on
// facts outside the process. `handleExecuteMerge` gets no DI hooks, so it runs
// a real `git merge --no-ff` in a temp repository with a real `EventStore`.
//
// The test carries its NEGATIVE TWIN: a distinct request identity that must
// not be deduped. Without the twin, a handler that never acts twice passes.
// The test gets its dispatch context from the production composition root,
// through `createPublicRootHarness()` in `_harness.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

import { handleExecuteMerge } from '../../../../src/verbs/merge/execute-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { createPublicRootHarness, type PublicRootHarness } from '../_harness.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const scratchDirs: string[] = [];
const openHarnesses: PublicRootHarness[] = [];

/**
 * Disposes each harness first, which closes its SQLite handles: on Windows an
 * open connection blocks the removal of its directory (EPERM). Teardown ignores its own errors, so a
 * leftover Windows file lock never shows as a test failure.
 */
afterEach(async () => {
  while (openHarnesses.length > 0) {
    try {
      await openHarnesses.pop()?.dispose();
    } catch {
    }
  }
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir === undefined) continue;
    try {
      rmrf(dir);
    } catch {
    }
  }
});

/**
 * Makes a temp directory and returns its real path. `os.tmpdir()` is a symlink
 * on some platforms, and git reports the real path.
 */
async function mkTemp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return fs.realpath(dir);
}

const TARGET_BRANCH = 'main';

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', [...args], { cwd: repoRoot });
}

/**
 * Makes a real repository on disk with one base commit. It renames the first
 * branch to `main`, because the default name depends on the git configuration.
 */
async function makeGitRepo(): Promise<string> {
  const repoRoot = await mkTemp('dr12-repo-');
  await git(repoRoot, ['init', '--quiet']);
  await git(repoRoot, ['config', 'user.email', 'dr12@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'DR-12 Fixture']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repoRoot, 'base.txt'), 'base\n', 'utf-8');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '--quiet', '-m', 'base']);
  await git(repoRoot, ['branch', '-M', TARGET_BRANCH]);
  return repoRoot;
}

/** Makes `branch` from `main`, adds one commit, and checks out `main` again. */
async function makeFeatureBranch(
  repoRoot: string,
  branch: string,
  file: string,
): Promise<void> {
  await git(repoRoot, ['checkout', '--quiet', '-b', branch, TARGET_BRANCH]);
  await fs.writeFile(path.join(repoRoot, file), `${file}\n`, 'utf-8');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '--quiet', '-m', `feat: ${file}`]);
  await git(repoRoot, ['checkout', '--quiet', TARGET_BRANCH]);
}

/** Counts the merge commits on `branch` with `git log --merges --oneline`. */
async function mergeCommitCount(repoRoot: string, branch: string): Promise<number> {
  const out = (await git(repoRoot, ['log', '--merges', '--oneline', branch])).trim();
  return out.length === 0 ? 0 : out.split('\n').filter((l) => l.trim()).length;
}

/** Counts the commits that are reachable from `branch`. */
async function revCount(repoRoot: string, branch: string): Promise<number> {
  return Number((await git(repoRoot, ['rev-list', '--count', branch])).trim());
}

async function revParse(repoRoot: string, rev: string): Promise<string> {
  return (await git(repoRoot, ['rev-parse', rev])).trim();
}

/**
 * Builds a public-root harness over an empty project root.
 * Each test makes one harness. A harness starts the storage backend of the process, so a second
 * harness replaces the backend of the first.
 */
async function makeHarness(): Promise<PublicRootHarness> {
  const projectRoot = await mkTemp('dr12-project-');
  const harness = await createPublicRootHarness({ projectRoot });
  openHarnesses.push(harness);
  return harness;
}

/** Starts a feature workflow through `dispatch`, so the store of the harness holds its state. */
async function initFeature(harness: PublicRootHarness, featureId: string): Promise<void> {
  const init = await harness.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });
  expect(init.success, `init of ${featureId} failed: ${init.errorCode ?? init.rejection ?? ''}`).toBe(true);
}

function countEvents(events: readonly WorkflowEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

describe('DR-12 — duplicate merge prevention (shipped path)', () => {
  /**
   * The handler gets no DI hooks, so it runs a real `git merge --no-ff` and
   * writes a real state file. Arm 1 replays one request in sequence. Arm 2
   * sends one request twice at the same time, and the loser can report a
   * conflict. Each arm must leave one merge commit and one `merge.executed`
   * event. The replay adds no commit after the feature commit and the merge.
   *
   * NEGATIVE TWIN: a different taskId and branch on the SAME stream must merge.
   * The idempotency claim is unique on (streamId, idempotencyKey). Thus only a
   * same-stream twin proves that the key of `merge-keys.ts` holds the taskId.
   */
  it('ExecuteMerge_DuplicateRequest_CreatesExactlyOneMergeCommit', async () => {
    const repoRoot = await makeGitRepo();
    await makeFeatureBranch(repoRoot, 'feat/dup', 'dup.txt');

    const harness = await makeHarness();
    const { ctx, eventStore } = harness;
    const featureId = 'dr12-merge-dup';
    await initFeature(harness, featureId);

    const baseMergeCommits = await mergeCommitCount(repoRoot, TARGET_BRANCH);
    const baseRevs = await revCount(repoRoot, TARGET_BRANCH);
    const featureTip = await revParse(repoRoot, 'feat/dup');
    expect(baseMergeCommits).toBe(0);

    const request = {
      featureId,
      sourceBranch: 'feat/dup',
      targetBranch: TARGET_BRANCH,
      taskId: 'T-18',
      strategy: 'merge' as const,
      repoRoot,
    };

    const first = await handleExecuteMerge({ ...request }, ctx);
    expect(first.success).toBe(true);

    expect(await mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(baseMergeCommits + 1);
    const mergeShaAfterFirst = await revParse(repoRoot, TARGET_BRANCH);
    expect(await revParse(repoRoot, `${TARGET_BRANCH}^2`)).toBe(featureTip);

    const second = await handleExecuteMerge({ ...request }, ctx);
    expect(second.success).toBe(true);

    expect(await mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(1);
    expect(await revCount(repoRoot, TARGET_BRANCH)).toBe(baseRevs + 2);
    expect(await revParse(repoRoot, TARGET_BRANCH)).toBe(mergeShaAfterFirst);

    const events = await eventStore.query(featureId);
    expect(countEvents(events, 'merge.executed')).toBe(1);
    expect(countEvents(events, 'merge.requested')).toBe(1);
    expect(countEvents(events, 'merge.completed')).toBe(1);
    expect(countEvents(events, 'merge.executing_started')).toBe(1);

    const raceRepo = await makeGitRepo();
    await makeFeatureBranch(raceRepo, 'feat/race', 'race.txt');
    const raceFeatureId = 'dr12-merge-race';
    await initFeature(harness, raceFeatureId);

    const raceRequest = {
      featureId: raceFeatureId,
      sourceBranch: 'feat/race',
      targetBranch: TARGET_BRANCH,
      taskId: 'T-18-race',
      strategy: 'merge' as const,
      repoRoot: raceRepo,
    };
    const [raceA, raceB] = await Promise.all([
      handleExecuteMerge({ ...raceRequest }, ctx),
      handleExecuteMerge({ ...raceRequest }, ctx),
    ]);

    expect(typeof raceA.success).toBe('boolean');
    expect(typeof raceB.success).toBe('boolean');
    expect([raceA, raceB].filter((r) => r.success).length).toBeGreaterThanOrEqual(1);

    expect(await mergeCommitCount(raceRepo, TARGET_BRANCH)).toBe(1);
    const raceEvents = await eventStore.query(raceFeatureId);
    expect(countEvents(raceEvents, 'merge.executed')).toBe(1);
    expect(countEvents(raceEvents, 'merge.requested')).toBe(1);

    await makeFeatureBranch(repoRoot, 'feat/other', 'other.txt');
    const other = await handleExecuteMerge(
      {
        featureId,
        sourceBranch: 'feat/other',
        targetBranch: TARGET_BRANCH,
        taskId: 'T-18-other',
        strategy: 'merge',
        repoRoot,
      },
      ctx,
    );
    expect(other.success).toBe(true);

    expect(await mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(2);
    expect(await revParse(repoRoot, `${TARGET_BRANCH}^2`)).toBe(
      await revParse(repoRoot, 'feat/other'),
    );
    const afterTwin = await eventStore.query(featureId);
    expect(countEvents(afterTwin, 'merge.executed')).toBe(2);
    expect(countEvents(afterTwin, 'merge.completed')).toBe(2);
    expect(
      afterTwin
        .filter((e) => e.type === 'merge.executed')
        .map((e) => (e.data as { sourceBranch: string }).sourceBranch)
        .sort(),
    ).toEqual(['feat/dup', 'feat/other']);

    const otherFeatureId = 'dr12-merge-other-feature';
    await initFeature(harness, otherFeatureId);
    await makeFeatureBranch(repoRoot, 'feat/third', 'third.txt');
    const third = await handleExecuteMerge(
      {
        featureId: otherFeatureId,
        sourceBranch: 'feat/third',
        targetBranch: TARGET_BRANCH,
        taskId: 'T-18-third',
        strategy: 'merge',
        repoRoot,
      },
      ctx,
    );
    expect(third.success).toBe(true);
    expect(await mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(3);
    expect(
      countEvents(await eventStore.query(otherFeatureId), 'merge.executed'),
    ).toBe(1);
  });
});
