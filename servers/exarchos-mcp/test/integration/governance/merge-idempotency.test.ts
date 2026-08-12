// ─── DR-12 acceptance — duplicate merge / duplicate PR are prevented ───────
//
// Second acceptance criterion of DR-12 ("the VCS census sees every mutation it
// claims to own"): *duplicate merge and duplicate PR are prevented through the
// shipped path*. The first criterion (a planted `['merge','--no-ff',x]` outside
// the owner turns the census RED) is pinned elsewhere.
//
// WHY THIS FILE EXISTS — the gap it closes:
//
//   The pre-existing merge tests (`src/orchestrate/execute-merge.test.ts`,
//   `merge-orchestrate.race.test.ts`) inject a MOCK `vcsMerge` and count mock
//   invocations. That proves the handler's control flow but not the outcome:
//   a mock cannot tell you how many merge commits exist. Likewise the
//   pre-existing `src/orchestrate/vcs/create-pr.test.ts` mocks
//   `createVcsProvider` wholesale, so the shipped `vcs/github.ts` provider —
//   the thing that actually builds the `gh pr create` argv — never runs.
//
//   Both tests below therefore ride the PRODUCTION call path and assert on
//   GROUND TRUTH beyond the process boundary:
//
//   • merge arm — `handleExecuteMerge` is invoked with NO DI hooks at all
//     (no `vcsMerge`, no `gitExec`, no `persistState`), so the real
//     `buildLocalGitMergeAdapter` + `defaultGitExec` shell out to a real
//     `git merge --no-ff` in a real temp repository, against a real
//     `EventStore` and a real workflow state file. The assertion counts
//     actual merge commits via `git log --merges` / `git rev-list --count`.
//
//   • PR arm — `handleCreatePr` runs against the real `createVcsProvider`
//     factory and the real `GitHubProvider` from `src/vcs/github.ts`. ONLY the
//     process boundary (`src/vcs/shell.ts::exec`) is faked, standing in for the
//     `gh` CLI + GitHub server. The assertion counts real `gh pr create`
//     invocations that crossed that boundary.
//
//   Neither test defines a test-local idempotent wrapper. The mechanisms under
//   test are `orchestrate/merge-keys.ts` +
//   the EventStore idempotency-claims substrate (merge arm) and the
//   natural-identity `listPrs({state:'open', head, base})` recovery precheck in
//   `orchestrate/vcs/create-pr.ts` (PR arm) — both live in `src/`.
//
//   Each test carries its NEGATIVE TWIN: a distinct request identity that MUST
//   NOT be deduped. Without it, an implementation that simply never acts twice
//   ("do nothing, ever") would satisfy a one-sided idempotency assertion.
//
// NOTE: this file is deliberately self-contained (no shared `_harness.ts`) —
// that module is owned by a separate task.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Fake ONLY the process boundary. `src/vcs/shell.ts` is the single `execFile`
// shim every provider funnels through, so replacing it leaves 100% of the
// shipped `GitHubProvider` logic (argv construction, stdout parsing, JSON
// decoding) executing for real. Hoisted by vitest above the imports below.
vi.mock('../../../src/vcs/shell.js', () => ({ exec: vi.fn() }));

import { exec as ghBoundary } from '../../../src/vcs/shell.js';
import { EventStore } from '../../../src/events/store.js';
import { handleExecuteMerge } from '../../../src/orchestrate/execute-merge.js';
import { handleCreatePr } from '../../../src/orchestrate/vcs/create-pr.js';
import { initStateFile } from '../../../src/workflow/state-store.js';
import { rmrf } from '../../../src/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../src/core/dispatch.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';

// ─── Temp-dir bookkeeping ──────────────────────────────────────────────────

const scratchDirs: string[] = [];
const openStores: EventStore[] = [];

afterEach(() => {
  vi.clearAllMocks();
  // Release the SQLite handles first — on Windows an open connection makes the
  // containing directory undeletable (EPERM).
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed — teardown is best-effort */
    }
  }
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir === undefined) continue;
    try {
      rmrf(dir);
    } catch {
      // Teardown hygiene only. A residual Windows file lock (git/AV/indexer)
      // must never be reported as a DR-12 assertion failure; the OS reclaims
      // %TEMP% regardless.
    }
  }
});

async function mkTemp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  // `os.tmpdir()` is a symlink on some platforms; realpath keeps the path we
  // hand to git identical to the one git reports back.
  return fs.realpath(dir);
}

// ─── Real-git fixture helpers (ground truth lives here) ────────────────────

const TARGET_BRANCH = 'main';

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** A real repository on disk with one base commit on `main`. */
async function makeGitRepo(): Promise<string> {
  const repoRoot = await mkTemp('dr12-repo-');
  git(repoRoot, ['init', '--quiet']);
  git(repoRoot, ['config', 'user.email', 'dr12@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'DR-12 Fixture']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repoRoot, 'base.txt'), 'base\n', 'utf-8');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', 'base']);
  // Normalize the initial branch name across git versions / init.defaultBranch.
  git(repoRoot, ['branch', '-M', TARGET_BRANCH]);
  return repoRoot;
}

/** Branch off `main`, add one commit, and return to `main`. */
async function makeFeatureBranch(
  repoRoot: string,
  branch: string,
  file: string,
): Promise<void> {
  git(repoRoot, ['checkout', '--quiet', '-b', branch, TARGET_BRANCH]);
  await fs.writeFile(path.join(repoRoot, file), `${file}\n`, 'utf-8');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', `feat: ${file}`]);
  git(repoRoot, ['checkout', '--quiet', TARGET_BRANCH]);
}

/**
 * GROUND TRUTH #1 — how many merge commits exist on `branch`.
 * Shells `git log --merges --oneline <branch>` and counts non-empty lines.
 */
function mergeCommitCount(repoRoot: string, branch: string): number {
  const out = git(repoRoot, ['log', '--merges', '--oneline', branch]).trim();
  return out.length === 0 ? 0 : out.split('\n').filter((l) => l.trim()).length;
}

/** GROUND TRUTH #2 — total commit count reachable from `branch`. */
function revCount(repoRoot: string, branch: string): number {
  return Number(git(repoRoot, ['rev-list', '--count', branch]).trim());
}

function revParse(repoRoot: string, rev: string): string {
  return git(repoRoot, ['rev-parse', rev]).trim();
}

// ─── DispatchContext wiring (mirrors merge-orchestrate.race.test.ts) ───────

interface Harness {
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
  readonly stateDir: string;
}

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

// ─── Fake `gh` server (the ONLY thing standing in for the network) ─────────

interface FakePr {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: string;
}

interface FakeGh {
  /** Every argv that crossed `src/vcs/shell.ts::exec`, in order. */
  readonly calls: string[][];
  /** Server-side PR table — the ground truth for "how many PRs exist". */
  readonly prs: FakePr[];
  createCalls(): string[][];
}

/**
 * Install a fake `gh` at the process boundary. Models just enough of the real
 * CLI for the shipped `GitHubProvider` to work unmodified:
 *   • `gh pr list --json … [--state s] [--head h] [--base b]` → filtered JSON
 *   • `gh pr create --title … --body … --base b --head h`     → new PR, prints URL
 *
 * `pr create` is UNCONDITIONAL, exactly like the real thing: it appends a row
 * every time it is called. So a duplicate PR here is a genuine duplicate — the
 * fake supplies no dedup of its own. Any prevention observed by the test is
 * therefore produced by production code, not by this fixture.
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
      // Real `gh` prints progress lines before the URL; reproduce that so the
      // shipped last-non-empty-line parser in github.ts is genuinely exercised.
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('DR-12 — duplicate merge and duplicate PR prevention (shipped path)', () => {
  it('ExecuteMerge_DuplicateRequest_CreatesExactlyOneMergeCommit', async () => {
    const repoRoot = await makeGitRepo();
    await makeFeatureBranch(repoRoot, 'feat/dup', 'dup.txt');

    const { ctx, eventStore, stateDir } = await makeHarness();
    const featureId = 'dr12-merge-dup';
    await initStateFile(stateDir, featureId, 'feature');

    const baseMergeCommits = mergeCommitCount(repoRoot, TARGET_BRANCH);
    const baseRevs = revCount(repoRoot, TARGET_BRANCH);
    const featureTip = revParse(repoRoot, 'feat/dup');
    expect(baseMergeCommits).toBe(0);

    // Identical request identity on every invocation — this is what makes the
    // second call a "duplicate request". NO DI hooks are passed, so the
    // handler builds its production adapters: `defaultGitExec` +
    // `buildLocalGitMergeAdapter` (real `git merge --no-ff`) +
    // `buildDefaultPersistState` (real state file).
    const request = {
      featureId,
      sourceBranch: 'feat/dup',
      targetBranch: TARGET_BRANCH,
      taskId: 'T-18',
      strategy: 'merge' as const,
      repoRoot,
    };

    // ── Arm 1: sequential REPLAY (crash-replay / re-dispatch shape) ─────────
    const first = await handleExecuteMerge({ ...request }, ctx);
    expect(first.success).toBe(true);

    // One real merge commit exists after the first call — proves the shipped
    // adapter actually mutated the repository (guards against the test passing
    // because nothing ever happened).
    expect(mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(baseMergeCommits + 1);
    const mergeShaAfterFirst = revParse(repoRoot, TARGET_BRANCH);
    // The merge commit's SECOND parent is the feature tip — it is a real merge
    // of the requested branch, not an unrelated commit.
    expect(revParse(repoRoot, `${TARGET_BRANCH}^2`)).toBe(featureTip);

    const second = await handleExecuteMerge({ ...request }, ctx);
    // A duplicate request is a clean no-op / cache-hit, NOT an error.
    expect(second.success).toBe(true);

    // ── GROUND TRUTH: exactly one merge commit, repo unchanged by the replay ─
    expect(mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(1);
    expect(revCount(repoRoot, TARGET_BRANCH)).toBe(baseRevs + 2); // feature commit + merge commit
    expect(revParse(repoRoot, TARGET_BRANCH)).toBe(mergeShaAfterFirst);

    // ── Durable-log truth: the idempotency key deduped the terminal events ──
    // This is the assertion that `orchestrate/merge-keys.ts` is load-bearing
    // for: without a deterministic key the replay's append lands a SECOND
    // `merge.executed` row on the stream.
    const events = await eventStore.query(featureId);
    expect(countEvents(events, 'merge.executed')).toBe(1);
    expect(countEvents(events, 'merge.requested')).toBe(1);
    expect(countEvents(events, 'merge.completed')).toBe(1);
    expect(countEvents(events, 'merge.executing_started')).toBe(1);

    // ── Arm 2: CONCURRENT duplicate (race shape, distinct failure mode) ────
    // A fresh repo/stream so the race is observed from a clean slate. The two
    // invocations share one request identity and are launched together.
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

    // Neither side crashed; at least one won outright. The loser is allowed to
    // surface a structured conflict — what it may NOT do is double-merge.
    expect(typeof raceA.success).toBe('boolean');
    expect(typeof raceB.success).toBe('boolean');
    expect([raceA, raceB].filter((r) => r.success).length).toBeGreaterThanOrEqual(1);

    expect(mergeCommitCount(raceRepo, TARGET_BRANCH)).toBe(1);
    const raceEvents = await raceHarness.eventStore.query(raceFeatureId);
    expect(countEvents(raceEvents, 'merge.executed')).toBe(1);
    expect(countEvents(raceEvents, 'merge.requested')).toBe(1);

    // ── NEGATIVE TWIN: a DIFFERENT merge identity must NOT be deduped ──────
    // Without this, "never merge twice, ever" would satisfy the assertions
    // above. A second, genuinely distinct merge must land its own commit and
    // its own durable event.
    //
    // Deliberately reuses the SAME featureId — i.e. the SAME event stream —
    // and varies only the taskId + source branch. That is the discriminating
    // case: the substrate's idempotency claim is UNIQUE on
    // (streamId, idempotencyKey), so a twin on a *different* stream would be
    // separated by the substrate no matter what the key contained, and would
    // therefore prove nothing about
    // `buildMergeOrchestrateIdempotencyKey`. Same-stream/different-task is the
    // only shape in which the key's identity segments are load-bearing.
    await makeFeatureBranch(repoRoot, 'feat/other', 'other.txt');
    const other = await handleExecuteMerge(
      {
        featureId, // SAME stream as arm 1 — on purpose.
        sourceBranch: 'feat/other',
        targetBranch: TARGET_BRANCH,
        taskId: 'T-18-other', // …distinct task identity.
        strategy: 'merge',
        repoRoot,
      },
      ctx,
    );
    expect(other.success).toBe(true);

    // A genuinely distinct merge produced a SECOND real merge commit…
    expect(mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(2);
    expect(revParse(repoRoot, `${TARGET_BRANCH}^2`)).toBe(
      revParse(repoRoot, 'feat/other'),
    );
    // …and a SECOND durable terminal event on the SAME stream. If the key
    // dropped its taskId segment, this collides with arm 1's claim and the
    // count stays at 1.
    const afterTwin = await eventStore.query(featureId);
    expect(countEvents(afterTwin, 'merge.executed')).toBe(2);
    expect(countEvents(afterTwin, 'merge.completed')).toBe(2);
    // The two terminal events describe the two DIFFERENT source branches —
    // the second is not an echo of the first.
    expect(
      afterTwin
        .filter((e) => e.type === 'merge.executed')
        .map((e) => (e.data as { sourceBranch: string }).sourceBranch)
        .sort(),
    ).toEqual(['feat/dup', 'feat/other']);

    // A cross-feature merge is likewise its own event on its own stream.
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
    expect(mergeCommitCount(repoRoot, TARGET_BRANCH)).toBe(3);
    expect(
      countEvents(await eventStore.query(otherFeatureId), 'merge.executed'),
    ).toBe(1);
  });

  it('CreatePr_DuplicateIdempotencyKey_CreatesExactlyOnePr', async () => {
    const gh = installFakeGh();
    const { ctx, eventStore } = await makeHarness();

    // The shipped idempotency anchor for PR creation is NATURAL IDENTITY —
    // (head branch, base branch) on the target repo — consumed by the
    // `listPrs({state:'open', head, base})` recovery precheck in
    // `orchestrate/vcs/create-pr.ts`. It is deliberately NOT a random value.
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

    // ── GROUND TRUTH: exactly ONE `gh pr create` crossed the boundary ──────
    const createCalls = gh.createCalls();
    expect(createCalls.length).toBe(1);
    expect(gh.prs.length).toBe(1);

    // Pin that the argv was built by the SHIPPED `GitHubProvider.createPr`
    // (src/vcs/github.ts), not by a stand-in provider: the exact flag order
    // and the absence of the invalid `--json` flag are that method's contract.
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
    // …and that the dedup lookup was the shipped `GitHubProvider.listPrs`
    // natural-identity query, not an invented one.
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

    // Both invocations report the SAME PR — the duplicate resolved to the
    // existing one rather than failing or inventing a new identifier.
    const firstData = first.data as { url: string; number: number };
    const secondData = second.data as { url: string; number: number };
    expect(secondData.url).toBe(firstData.url);
    expect(secondData.number).toBe(firstData.number);
    expect(firstData.number).toBe(gh.prs[0]?.number);

    // Durable log: both attempts recorded a result, and BOTH point at the one
    // real PR — the second went through the idempotent short-circuit branch.
    const vcsEvents = await eventStore.query('vcs');
    const executed = vcsEvents.filter((e) => e.type === 'pr.create.executed');
    expect(executed.length).toBe(2);
    for (const ev of executed) {
      expect((ev.data as { prNumber: number }).prNumber).toBe(firstData.number);
    }

    // ── NEGATIVE TWIN: a DIFFERENT identity MUST create a second PR ────────
    // Same base, different head. If the handler simply refused to ever create
    // twice, this would (correctly) fail.
    const differentHead = await handleCreatePr(
      { ...duplicateRequest, head: 'feat/dr12-pr-two' },
      ctx,
    );
    expect(differentHead.success).toBe(true);
    expect(gh.createCalls().length).toBe(2);
    expect(gh.prs.length).toBe(2);
    const differentData = differentHead.data as { url: string; number: number };
    expect(differentData.number).not.toBe(firstData.number);

    // …and a different BASE for the same head is likewise a distinct PR.
    const differentBase = await handleCreatePr(
      { ...duplicateRequest, base: 'release/1.x' },
      ctx,
    );
    expect(differentBase.success).toBe(true);
    expect(gh.createCalls().length).toBe(3);
    expect(gh.prs.length).toBe(3);

    // Re-requesting the ORIGINAL identity still dedups after the twins ran —
    // the natural-identity lookup did not get confused by the neighbours.
    const replay = await handleCreatePr({ ...duplicateRequest }, ctx);
    expect(replay.success).toBe(true);
    expect(gh.createCalls().length).toBe(3);
    expect((replay.data as { number: number }).number).toBe(firstData.number);
  });
});
