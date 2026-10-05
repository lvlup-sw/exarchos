// Duplicate merge and duplicate PR are prevented through the shipped path.
//
// A test with a mock `vcsMerge` or a mock provider counts mock calls. It cannot
// count merge commits or `gh pr create` calls. The tests in this file run the
// production call path and assert on facts outside the process.
//
// - Merge arm: `handleExecuteMerge` gets no DI hooks, so it runs a real
//   `git merge --no-ff` in a temp repository with a real `EventStore`.
// - PR arm: `handleCreatePr` runs the real `GitHubProvider`. The `vi.mock` of
//   `src/vcs/shell.ts` fakes only the process boundary: the one `execFile` shim
//   that each provider calls.
//
// Each test carries its NEGATIVE TWIN: a distinct request identity that must
// not be deduped. Without the twin, a handler that never acts twice passes.
// This file builds its own `DispatchContext` and does not use `_harness.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

vi.mock('../../../../src/vcs/shell.js', () => ({ exec: vi.fn() }));

import { exec as ghBoundary } from '../../../../src/vcs/shell.js';
import { EventStore } from '../../../../src/events/store.js';
import { handleExecuteMerge } from '../../../../src/verbs/merge/execute-merge.js';
import { handleCreatePr } from '../../../../src/verbs/vcs/create-pr.js';
import { initStateFile } from '../../../../src/workflow/state-store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const scratchDirs: string[] = [];
const openStores: EventStore[] = [];

/**
 * Closes the SQLite handles first: on Windows an open connection blocks the
 * removal of its directory (EPERM). Teardown ignores its own errors, so a
 * leftover Windows file lock never shows as a test failure.
 */
afterEach(() => {
  vi.clearAllMocks();
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
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

interface Harness {
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
  readonly stateDir: string;
}

/** Builds a `DispatchContext` from an object literal over a real `EventStore` in a temp state directory. */
async function makeHarness(): Promise<Harness> {
  const stateDir = await mkTemp('dr12-state-');
  await fs.mkdir(path.join(stateDir, 'workflow-state'), { recursive: true });
  const eventStore = new EventStore(stateDir);
  openStores.push(eventStore);
  const ctx = {
    stateDir,
    eventStore,
    enableTelemetry: false,
    projectConfig: {
      vcs: { provider: 'github', settings: {} },
    } as unknown as ResolvedProjectConfig,
  } as unknown as DispatchContext;
  return { ctx, eventStore, stateDir };
}

function countEvents(events: readonly WorkflowEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

interface FakePr {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: string;
}

interface FakeGh {
  /** Each argv that crossed `src/vcs/shell.ts::exec`, in order. */
  readonly calls: string[][];
  /** The PR table of the fake server. Its length is the number of PRs that exist. */
  readonly prs: FakePr[];
  createCalls(): string[][];
}

/**
 * Installs a fake `gh` at the process boundary. It models `gh pr list` with
 * the `--state`, `--head` and `--base` filters, and `gh pr create`.
 *
 * `pr create` appends a row on each call and has no dedup of its own. Thus
 * production code causes each prevention that a test sees. The output has a
 * progress line before the URL, as the real `gh` prints, so the provider must
 * parse the last non-empty line.
 */
function installFakeGh(): FakeGh {
  const calls: string[][] = [];
  const prs: FakePr[] = [];
  let nextNumber = 100;

  const flag = (args: readonly string[], name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  vi.mocked(ghBoundary).mockImplementation(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command !== 'gh') throw new Error(`fake gh: unexpected command '${command}'`);

    if (args[0] === 'pr' && args[1] === 'list') {
      const state = flag(args, '--state');
      const head = flag(args, '--head');
      const base = flag(args, '--base');
      const matched = prs.filter(
        (pr) =>
          (state === undefined || state === 'all' || pr.state === state) &&
          (head === undefined || pr.headRefName === head) &&
          (base === undefined || pr.baseRefName === base),
      );
      return JSON.stringify(matched);
    }

    if (args[0] === 'pr' && args[1] === 'create') {
      const number = nextNumber++;
      const url = `https://github.com/acme/repo/pull/${number}`;
      prs.push({
        number,
        url,
        title: flag(args, '--title') ?? '',
        headRefName: flag(args, '--head') ?? '',
        baseRefName: flag(args, '--base') ?? '',
        state: 'open',
      });
      return `\nCreating pull request for ${flag(args, '--head')} into ${flag(args, '--base')}\n${url}`;
    }

    throw new Error(`fake gh: unhandled argv ${JSON.stringify(args)}`);
  });

  return {
    calls,
    prs,
    createCalls: () => calls.filter((c) => c[1] === 'pr' && c[2] === 'create'),
  };
}

describe('DR-12 — duplicate merge and duplicate PR prevention (shipped path)', () => {
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

    const { ctx, eventStore, stateDir } = await makeHarness();
    const featureId = 'dr12-merge-dup';
    await initStateFile(stateDir, featureId, 'feature');

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
    const raceHarness = await makeHarness();
    const raceFeatureId = 'dr12-merge-race';
    await initStateFile(raceHarness.stateDir, raceFeatureId, 'feature');

    const raceRequest = {
      featureId: raceFeatureId,
      sourceBranch: 'feat/race',
      targetBranch: TARGET_BRANCH,
      taskId: 'T-18-race',
      strategy: 'merge' as const,
      repoRoot: raceRepo,
    };
    const [raceA, raceB] = await Promise.all([
      handleExecuteMerge({ ...raceRequest }, raceHarness.ctx),
      handleExecuteMerge({ ...raceRequest }, raceHarness.ctx),
    ]);

    expect(typeof raceA.success).toBe('boolean');
    expect(typeof raceB.success).toBe('boolean');
    expect([raceA, raceB].filter((r) => r.success).length).toBeGreaterThanOrEqual(1);

    expect(await mergeCommitCount(raceRepo, TARGET_BRANCH)).toBe(1);
    const raceEvents = await raceHarness.eventStore.query(raceFeatureId);
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
    await initStateFile(stateDir, otherFeatureId, 'feature');
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

  /**
   * The idempotency anchor of PR creation is natural identity: the head branch
   * and the base branch. `verbs/vcs/create-pr.ts` looks for an open PR with
   * that identity before it creates one. The argv assertions pin that the
   * shipped `GitHubProvider` built the `pr create` call and the `pr list`
   * lookup. Each attempt records a `pr.create.executed` event for the one PR.
   *
   * NEGATIVE TWIN: a different head, or a different base, must create a new PR.
   * A replay of the first identity after the twins must still dedup.
   */
  it('CreatePr_DuplicateIdempotencyKey_CreatesExactlyOnePr', async () => {
    const gh = installFakeGh();
    const { ctx, eventStore } = await makeHarness();

    const duplicateRequest = {
      title: 'feat: DR-12 duplicate PR prevention',
      body: 'Body for the DR-12 acceptance fixture.',
      base: 'main',
      head: 'feat/dr12-pr',
    };

    const first = await handleCreatePr({ ...duplicateRequest }, ctx);
    const second = await handleCreatePr({ ...duplicateRequest }, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const createCalls = gh.createCalls();
    expect(createCalls.length).toBe(1);
    expect(gh.prs.length).toBe(1);

    expect(createCalls[0]).toEqual([
      'gh',
      'pr',
      'create',
      '--title',
      duplicateRequest.title,
      '--body',
      duplicateRequest.body,
      '--base',
      'main',
      '--head',
      'feat/dr12-pr',
    ]);
    expect(gh.calls).toContainEqual([
      'gh',
      'pr',
      'list',
      '--json',
      'number,url,title,headRefName,baseRefName,state',
      '--state',
      'open',
      '--head',
      'feat/dr12-pr',
      '--base',
      'main',
    ]);

    const firstData = first.data as { url: string; number: number };
    const secondData = second.data as { url: string; number: number };
    expect(secondData.url).toBe(firstData.url);
    expect(secondData.number).toBe(firstData.number);
    expect(firstData.number).toBe(gh.prs[0]?.number);

    const vcsEvents = await eventStore.query('vcs');
    const executed = vcsEvents.filter((e) => e.type === 'pr.create.executed');
    expect(executed.length).toBe(2);
    for (const ev of executed) {
      expect((ev.data as { prNumber: number }).prNumber).toBe(firstData.number);
    }

    const differentHead = await handleCreatePr(
      { ...duplicateRequest, head: 'feat/dr12-pr-two' },
      ctx,
    );
    expect(differentHead.success).toBe(true);
    expect(gh.createCalls().length).toBe(2);
    expect(gh.prs.length).toBe(2);
    const differentData = differentHead.data as { url: string; number: number };
    expect(differentData.number).not.toBe(firstData.number);

    const differentBase = await handleCreatePr(
      { ...duplicateRequest, base: 'release/1.x' },
      ctx,
    );
    expect(differentBase.success).toBe(true);
    expect(gh.createCalls().length).toBe(3);
    expect(gh.prs.length).toBe(3);

    const replay = await handleCreatePr({ ...duplicateRequest }, ctx);
    expect(replay.success).toBe(true);
    expect(gh.createCalls().length).toBe(3);
    expect((replay.data as { number: number }).number).toBe(firstData.number);
  });
});
