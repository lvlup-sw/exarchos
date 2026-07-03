// ─── DR-12 — error handling & failure modes for the liveness + merge surface ──
//
// The crash / concurrency recovery edges that the Task-006 lease loop and the
// Task-007 prune ladder do NOT cover on their own:
//
//   1. Crash-mid-merge resume — an unpaired `worktree.merge_requested` whose
//      holder is THIS process (a failed best-effort release) or provably dead,
//      idempotently terminated EXACTLY ONCE behind a `merge-base --is-ancestor`
//      precheck (INV-8/13).
//   2. Concurrent prune + merge — the GC must SKIP a worktree (or its
//      integration branch) holding an unpaired in-flight merge lease, re-folded
//      under the claim — no double-free.
//   3. Exhausted index.lock retry — the structured `IndexLockContentionError`
//      surfaces to the caller and the slot is released (no half-merge).
//   4. No `git reset --hard` — the serializer introduces none of its own; the
//      INV-14 `--abort` → `--keep` + `recoveryError` pass through from the
//      UNCHANGED `merge_orchestrate`.
//
// The crash / concurrency assertions run against a REAL SQLite EventStore (the
// substrate's in-transaction stream-version gate is the cross-process guard);
// the prune assertion additionally drives a REAL git repo so the skip is pinned
// against ground-truth `git` ancestry, not a mock.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

import { serializeMerge, resumeCrashedMerge } from './merge-serializer.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from './manager.js';
import type { WorktreesProjection } from './projections/worktrees.js';
import type { ProcessTableSource, ProcessRecord } from './pure/probe.js';
import type { ProcessSource, StartTimeProbe } from './pure/process-identity.js';
import { IndexLockContentionError, type SleepFn } from './git-retry.js';
import { canonicalWorktreeId } from './pure/path-containment.js';

// ─── Arm: one stateDir + EventStore + ctx (real SQLite) ──────────────────────

interface Arm {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly ctx: DispatchContext;
}

const arms: Arm[] = [];
const repoDirs: string[] = [];

async function createArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-recovery-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  const arm = { stateDir, eventStore, ctx };
  arms.push(arm);
  return arm;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (arms.length > 0) {
    const arm = arms.pop();
    if (arm) {
      arm.eventStore.close();
      await rmrfAsync(arm.stateDir);
    }
  }
  while (repoDirs.length > 0) {
    const dir = repoDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Live process table reporting exactly the listed (pid, startTime) pairs alive. */
function liveTable(pairs: ReadonlyArray<{ pid: number; startTime: string }>): ProcessTableSource {
  const records: ProcessRecord[] = pairs.map(({ pid, startTime }) => ({
    pid,
    ppid: 1,
    cwd: `/proc-fixture/${pid}`,
    startTime,
  }));
  return { list: () => records };
}

/** Empty but SUPPORTED process table — every probed pid reads as absent (provably dead). */
const EMPTY_TABLE: ProcessTableSource = { list: () => [] };

/**
 * UNSUPPORTED process table — the off-Linux shape (no enumerator, DR-11/#1579).
 * `list()` is `[]` but `isSupported()` is `false`, so a probed pid reads as
 * `'unknown'`, NEVER provably dead. Reclaim consumers must fail closed against
 * it (REV-H1). Mirrors the real `defaultProcessTableSource` off-Linux.
 */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

/** A per-PID create-time source backed by a map (absent pid ⇒ exited). */
function startTimeSource(table: Record<number, string>): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      return Object.prototype.hasOwnProperty.call(table, pid)
        ? { status: 'present', startedAt: table[pid] }
        : { status: 'absent' };
    },
  };
}

/** Directly seed a held lease (CLAIM) on the worktrees stream. */
async function seedHolder(
  arm: Arm,
  holder: {
    integrationRef: string;
    operationId: string;
    sourceBranch: string;
    holderPid: number;
    holderStartedAt: string;
    worktreeId?: string;
  },
): Promise<void> {
  await arm.eventStore.getAppender().append(
    WORKTREES_STREAM,
    [{ type: 'worktree.merge_requested', data: { ...holder } }],
    `worktree.merge_requested:${holder.operationId}`,
  );
}

async function foldWorktrees(arm: Arm): Promise<WorktreesProjection> {
  const { aggregate } = await arm.eventStore
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

function executedFor(events: ReadonlyArray<{ type: string; data?: Record<string, unknown> }>, operationId: string) {
  return events.filter(
    (e) => e.type === 'worktree.merge_executed' && e.data?.operationId === operationId,
  );
}

// ─── Test 1: crash-mid-merge resume emits a single terminal (real SQLite) ─────

describe('DR-12 — crash-mid-merge resume', () => {
  it('Recovery_MergeRequestedNoExecuted_ResumeEmitsSingleExecuted', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/resume';
    const opId = 'self-stuck-op';
    // A SAME-PROCESS stuck lease: this process holds it (best-effort release
    // failed), so the inline dead-holder probe would never reclaim it (we are
    // alive) — resumeCrashedMerge must finish OUR OWN lease.
    await seedHolder(arm, {
      integrationRef,
      operationId: opId,
      sourceBranch: 'feat/resume',
      holderPid: 321,
      holderStartedAt: 'self-321',
    });

    const merged: string[] = [];
    const outcome = await resumeCrashedMerge(
      { featureId: 'F', integrationRef, strategy: 'merge', repoRoot: '/unused' },
      arm.ctx,
      {
        selfPid: 321,
        selfStartedAt: 'self-321',
        processTableSource: liveTable([{ pid: 321, startTime: 'self-321' }]), // we are alive.
        isMergeApplied: () => true, // the pre-crash merge SUCCEEDED → skip re-merge.
        mergeOrchestrate: async (input) => {
          merged.push(input.featureId);
          return { success: true, data: { phase: 'completed' } };
        },
      },
    );

    expect(outcome.resumed).toBe(true);
    if (outcome.resumed) {
      expect(outcome.operationId).toBe(opId);
      expect(outcome.holderKind).toBe('self');
      expect(outcome.reMerged).toBe(false); // precheck said already applied.
    }
    // The precheck short-circuited the re-merge.
    expect(merged).toEqual([]);

    // Exactly ONE terminal release landed under the holder's ORIGINAL operationId.
    let events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, opId)).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();

    // Idempotent: a SECOND resume finds no unpaired lease and emits nothing —
    // the terminal stays exactly one (INV-8/13 exactly-once).
    const again = await resumeCrashedMerge(
      { featureId: 'F', integrationRef, strategy: 'merge', repoRoot: '/unused' },
      arm.ctx,
      { selfPid: 321, selfStartedAt: 'self-321', processTableSource: EMPTY_TABLE, isMergeApplied: () => true },
    );
    expect(again.resumed).toBe(false);
    if (!again.resumed) expect(again.reason).toBe('no-lease');
    events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, opId)).toHaveLength(1);
  });
});

// ─── Test 2: dead-holder reclaimed inline WITHOUT consuming the budget ────────

describe('DR-12 — stale dead-holder reclamation', () => {
  it('Recovery_StaleLeaseDeadHolder_WaitLoopReclaimsInlineNoFullTimeout', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/dead-inline';
    await seedHolder(arm, {
      integrationRef,
      operationId: 'dead-op',
      sourceBranch: 'feat/dead',
      holderPid: 9090,
      holderStartedAt: 'gone-9090',
    });

    // A fake clock proves the budget was never spent: `sleep` throws, so any
    // wait iteration fails the test — the dead holder must be reclaimed inline.
    let clock = 0;
    const sleep: SleepFn = async () => {
      throw new Error('dead-holder reclaim must not wait out the budget');
    };
    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/live', strategy: 'merge', timeoutMs: 30_000 },
      arm.ctx,
      {
        now: () => clock,
        sleep,
        processTableSource: EMPTY_TABLE, // pid 9090 absent → provably dead.
        selfPid: 111,
        selfStartedAt: 'self-111',
        mergeOrchestrate: async (input) => {
          merged.push(input.featureId);
          return { success: true, data: { phase: 'completed' } };
        },
        readIntegrationHead: () => null,
      },
    );

    expect(result.success).toBe(true);
    expect(merged).toEqual(['F']);
    // The deadline (clock + timeoutMs) was never approached — clock never moved.
    expect(clock).toBe(0);

    // The dead holder's terminal rode its OWN operationId; the slot ends clear.
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, 'dead-op')).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });

  it('Recovery_StaleLeaseDeadHolder_ReconcilePathAlsoReclaims', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/dead-reconcile';
    // A DIFFERENT pid (4242), provably dead — the explicit recovery pass reclaims
    // it too, not only the inline wait loop. Precheck says "not applied" so the
    // resume re-runs the merge before terminating the lease.
    await seedHolder(arm, {
      integrationRef,
      operationId: 'crashed-op',
      sourceBranch: 'feat/crashed',
      holderPid: 4242,
      holderStartedAt: 'gone-4242',
    });

    const merged: string[] = [];
    const outcome = await resumeCrashedMerge(
      { featureId: 'F', integrationRef, strategy: 'merge', repoRoot: '/unused' },
      arm.ctx,
      {
        selfPid: 111,
        selfStartedAt: 'self-111', // not the holder → relies on dead detection.
        processTableSource: EMPTY_TABLE, // pid 4242 absent → provably dead.
        isMergeApplied: () => false, // not applied → resume re-runs the merge.
        mergeOrchestrate: async (input) => {
          merged.push(input.featureId);
          return { success: true, data: { phase: 'completed' } };
        },
      },
    );

    expect(outcome.resumed).toBe(true);
    if (outcome.resumed) {
      expect(outcome.holderKind).toBe('dead');
      expect(outcome.reMerged).toBe(true);
      expect(outcome.operationId).toBe('crashed-op');
    }
    expect(merged).toEqual(['F']); // the resume re-ran the merge.

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, 'crashed-op')).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

// ─── Test 3: concurrent prune + merge — prune skips an in-flight lease ────────

describe('DR-12 — concurrent prune + merge', () => {
  // Real-git helpers (mirrors the prune suite's ground-truth setup).
  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args as string[], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  async function initRepoWithOrigin(workdir: string, name: string): Promise<string> {
    const origin = path.join(workdir, `${name}-origin.git`);
    git(workdir, ['init', '-q', '--bare', origin]);
    const repo = path.join(workdir, name);
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'work']);
    git(repo, ['config', 'user.email', 'wlm@example.com']);
    git(repo, ['config', 'user.name', 'WLM Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(repo, 'README.md'), '# wlm recovery prune\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const real = realpathSync(repo);
    git(real, ['remote', 'add', 'origin', origin]);
    git(real, ['push', '-q', 'origin', 'work']);
    return real;
  }

  it('Recovery_ConcurrentPruneAndMerge_PruneSkipsBranchWithInFlightLease', async () => {
    const arm = await createArm();
    const workdir = await mkdtemp(path.join(tmpdir(), 'wlm-recovery-work-'));
    repoDirs.push(workdir);

    const repo = await initRepoWithOrigin(workdir, 'repo');
    const integrationRef = 'feat/integ';
    git(repo, ['branch', integrationRef]); // integration ref at HEAD.
    const wtPath = path.join(workdir, 'wt-merging');
    git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'wbranch']); // HEAD == integ → merged.
    const wtId = canonicalWorktreeId(wtPath);

    // Wire the worktree's feature → integration branch (per-worktree ref lookup).
    await arm.eventStore.append('feat-merge', {
      type: 'state.patched',
      data: { patch: { 'synthesis.integrationBranch': integrationRef } },
    });

    const manager = new WorktreeManager({ eventStore: arm.eventStore });
    // Reserve → release so it folds to `released` (clean, merged, origin-reachable
    // = the exact delete-eligible shape the GC would otherwise reclaim).
    await manager.reserve({
      worktreeId: wtId,
      path: wtPath,
      featureId: 'feat-merge',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });
    await manager.release(wtId);

    // A live `serialize_merge` holds the lease on the SAME integration branch —
    // the serializer leaves `worktreeId` null, so the integration-ref match is
    // what must catch the race.
    await seedHolder(arm, {
      integrationRef,
      operationId: 'merge-in-flight',
      sourceBranch: 'wbranch',
      holderPid: 7777,
      holderStartedAt: 'alive-7777',
    });

    const result = await manager.prune({ repoRoot: repo, apply: true });

    // Skipped on the in-flight lease — never deleted (no double-free).
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'in-flight-merge' });
    expect(result.deleted).not.toContain(wtId);
    expect(result.skipsByReason['in-flight-merge']).toContain(wtId);
    // The under-lock guard committed NO delete intent for it.
    const removeReqs = (await arm.eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'worktree.remove.requested' &&
        (e.data as { worktreeId?: unknown }).worktreeId === wtId,
    );
    expect(removeReqs).toHaveLength(0);
    // Still tracked + still on disk (released, not removed).
    expect((await foldWorktrees(arm)).worktrees[wtId]?.state).toBe('released');
  });
});

// ─── Test 4: exhausted index.lock retry surfaces structured error, no half-merge

describe('DR-12 — exhausted index.lock retry', () => {
  it('Recovery_ExhaustedIndexLockRetry_SurfacesStructuredErrorNoHalfMerge', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/locked';

    // The now-real DR-1/DR-8 retry seam lives one layer down, in the default
    // `defaultGitExec` composition (wrapped in `withIndexLockRetrySync`), which
    // retries transient `.git/index.lock` contention with bounded backoff and, on
    // exhaustion, surfaces a structured contention failure. This test does NOT
    // exercise that kernel (it owns dedicated coverage in git-retry.test.ts +
    // git-exec-default.test.ts); it fabricates a terminal structured error and
    // injects it via `mergeOrchestrate` to isolate ONE thing: the serializer
    // passes a structured contention error through UNCHANGED (INV-14) and still
    // releases the lease in `finally` (no half-merge).
    const lockErr = new IndexLockContentionError(
      { lockPath: '/repo/.git/index.lock', attempts: 4, maxRetries: 3, delaysMs: [200, 400, 800] },
      new Error("fatal: Unable to create '/repo/.git/index.lock': File exists."),
    );

    let caught: unknown;
    try {
      await serializeMerge(
        { featureId: 'F', integrationRef, sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 10_000 },
        arm.ctx,
        {
          selfPid: 555,
          selfStartedAt: 'self-555',
          mergeOrchestrate: async () => {
            throw lockErr;
          },
          readIntegrationHead: () => null,
        },
      );
    } catch (err) {
      caught = err;
    }

    // The structured error reaches the caller UNCHANGED — never a silent no-op.
    expect(caught).toBe(lockErr);
    expect(caught).toBeInstanceOf(IndexLockContentionError);
    expect((caught as IndexLockContentionError).code).toBe('INDEX_LOCK_CONTENTION');

    // No half-merge: the lease was released in `finally`, so the slot is clear —
    // the workflow is not left wedged mid-merge.
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const claims = events.filter((e) => e.type === 'worktree.merge_requested');
    const releases = events.filter((e) => e.type === 'worktree.merge_executed');
    expect(claims).toHaveLength(1);
    expect(releases).toHaveLength(1); // exactly one claim + one matching release.
  });
});

// ─── Test 5: serializer introduces no reset --hard; recoveryError passes through

describe('DR-12 — no reset --hard, INV-14 pass-through', () => {
  it('Recovery_SerializerIntroducesNoResetHard_SurfacesRecoveryErrorFromMergeOrchestrate', async () => {
    // (a) Static: the serializer source has NO `git reset --hard` path of its
    // own. Strip comments first so the module's own prose ("never `--hard`")
    // cannot false-negative the assertion.
    const sourcePath = fileURLToPath(new URL('./merge-serializer.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf-8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keep "://" in URLs)
    expect(code).not.toMatch(/--hard/i);
    expect(code).not.toMatch(/\breset\b/i); // no reset path at all in the serializer.

    // (b) Behavioral: when the composed merge_orchestrate reverses via the INV-14
    // ladder (`--abort` → `--keep`) and surfaces a `recoveryError`, the serializer
    // passes the result through UNCHANGED and still releases the lease.
    const arm = await createArm();
    const integrationRef = 'integration/reversed';
    const rolledBack: ToolResult = {
      success: false,
      error: { code: 'MERGE_ROLLED_BACK', message: 'merge reversed' },
      data: {
        phase: 'rolled-back',
        recoveryError: 'reset-keep-blocked',
        recoveryErrorDetail: 'git reset --keep refused to discard local work',
      },
    };

    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      {
        selfPid: 666,
        selfStartedAt: 'self-666',
        mergeOrchestrate: async () => rolledBack,
        readIntegrationHead: () => null,
      },
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('rolled-back');
    expect(data.recoveryError).toBe('reset-keep-blocked');
    expect(data.recoveryErrorDetail).toBe('git reset --keep refused to discard local work');
    // The lease was released despite the reversal — no wedged slot.
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

// ─── Test 6: off-Linux unsupported table reclaims/orphans NOTHING (REV-H1) ────

describe('DR-12 — unsupported process table fails closed (REV-H1)', () => {
  it('ProbeAndReclaim_UnsupportedTable_EmitsNoEvents', async () => {
    const arm = await createArm();
    const manager = new WorktreeManager({
      eventStore: arm.eventStore,
      processTableSource: UNSUPPORTED_TABLE,
    });

    // A reserved worktree whose owner pid (4242) is absent from the empty table.
    // On a SUPPORTED table this owner reads provably dead and the probe emits
    // worktree.released; on the UNSUPPORTED table it reads 'unknown', so the
    // probe must emit NOTHING — fail closed, never a spurious heal off-Linux.
    const wtId = '/wlm/unsupported-wt';
    await manager.reserve({
      worktreeId: wtId,
      path: wtId,
      featureId: 'F',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });

    const before = (await arm.eventStore.query(WORKTREES_STREAM)).length;
    const result = await manager.probeAndReclaim(999999); // selfPid not in table.

    expect(result.released).toEqual([]);
    expect(result.orphaned).toEqual([]);
    expect(result.probed).toBe(1);
    // No terminal lifecycle event was appended — the reservation stands.
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(events.length).toBe(before);
    expect(events.some((e) => e.type === 'worktree.released')).toBe(false);
    expect(events.some((e) => e.type === 'worktree.orphan_detected')).toBe(false);
    expect((await foldWorktrees(arm)).worktrees[wtId]?.state).toBe('reserved');
  });
});

// ─── Test 6b: one failed reclaim never aborts the batch (CodeRabbit #4621186637) ─

describe('probeAndReclaim — per-entry fault isolation', () => {
  it('ProbeAndReclaim_OneReleaseAppendThrows_RemainingStillReclaimed', async () => {
    const arm = await createArm();
    // EMPTY but SUPPORTED table → both reserved owners read provably dead, so
    // both are releasable. Reserve two so the batch has more than one target.
    const manager = new WorktreeManager({
      eventStore: arm.eventStore,
      processTableSource: EMPTY_TABLE,
    });
    const wtFail = '/wlm/reclaim-fails';
    const wtOk = '/wlm/reclaim-succeeds';
    await manager.reserve({ worktreeId: wtFail, path: wtFail, featureId: 'F', ownerPid: 4242, ownerStartedAt: 'boot-4242' });
    await manager.reserve({ worktreeId: wtOk, path: wtOk, featureId: 'F', ownerPid: 4343, ownerStartedAt: 'boot-4343' });

    // Inject a transient persistence failure for ONLY the first worktree's
    // release append; every other append delegates to the real store. A generic
    // Error is not in withStateRetry's retryable set, so it propagates at once.
    const realAppend = arm.eventStore.append.bind(arm.eventStore);
    const appendSpy = vi
      .spyOn(arm.eventStore, 'append')
      .mockImplementation((streamId, event, options) => {
        const worktreeId = (event as { data?: { worktreeId?: string } }).data?.worktreeId;
        if (event.type === 'worktree.released' && worktreeId === wtFail) {
          throw new Error('injected append failure');
        }
        return realAppend(streamId, event, options);
      });

    // Must NOT throw despite the first entry failing.
    const result = await manager.probeAndReclaim(999999);
    appendSpy.mockRestore();

    expect(result.probed).toBe(2);
    // Truthful counts (INV-1): only the entry whose event provably landed is
    // reported released — the failed one is NOT (no phantom reclaim).
    expect(result.released).toContain(wtOk);
    expect(result.released).not.toContain(wtFail);
    expect(result.orphaned).toEqual([]);

    // The failed entry stays `reserved` (retried next pass, INV-8); the other
    // folded to `released`.
    const projection = await foldWorktrees(arm);
    expect(projection.worktrees[wtFail]?.state).toBe('reserved');
    expect(projection.worktrees[wtOk]?.state).toBe('released');
  });
});

// ─── Test 7: two concurrent resumes never double-merge (REV-M1 OCC) ───────────

describe('DR-12 — concurrent resume does not double-merge (REV-M1)', () => {
  it('Recovery_TwoConcurrentResumes_OccPreventsDoubleMerge', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/concurrent-resume';
    const opId = 'crashed-op';

    // A CRASHED holder (pid 9999, absent → provably dead). Two DIFFERENT live
    // processes (101, 102) both attempt to resume it concurrently. Without the
    // OCC re-claim both pass the read-only `isMergeApplied` precheck and both
    // re-run merge_orchestrate — a DOUBLE merge. The re-claim must serialize them
    // so the merge runs AT MOST once.
    await seedHolder(arm, {
      integrationRef,
      operationId: opId,
      sourceBranch: 'feat/crashed',
      holderPid: 9999,
      holderStartedAt: 'gone-9999',
    });

    // 9999 absent (dead); BOTH resumers (101, 102) read alive, so once one
    // re-claims the slot the other sees a LIVE foreign holder and backs off.
    const table = liveTable([
      { pid: 101, startTime: 'live-101' },
      { pid: 102, startTime: 'live-102' },
    ]);

    let mergeCount = 0;
    const mergeOrchestrate = async (): Promise<ToolResult> => {
      mergeCount += 1;
      // Hold briefly so the loser's OCC attempt overlaps the winner's merge.
      await new Promise((r) => setTimeout(r, 40));
      return { success: true, data: { phase: 'completed' } };
    };

    const resumeDeps = (selfPid: number, selfStartedAt: string) => ({
      selfPid,
      selfStartedAt,
      processTableSource: table,
      isMergeApplied: () => false, // not applied → both WANT to re-merge.
      mergeOrchestrate,
    });

    const [a, b] = await Promise.all([
      resumeCrashedMerge(
        { featureId: 'F', integrationRef, strategy: 'merge', repoRoot: '/unused' },
        arm.ctx,
        resumeDeps(101, 'live-101'),
      ),
      resumeCrashedMerge(
        { featureId: 'F', integrationRef, strategy: 'merge', repoRoot: '/unused' },
        arm.ctx,
        resumeDeps(102, 'live-102'),
      ),
    ]);

    // THE invariant: the merge ran AT MOST once across the two concurrent resumes.
    expect(mergeCount).toBe(1);

    // Exactly one resume won; the other backed off without re-merging.
    const outcomes = [a, b];
    const winners = outcomes.filter((o) => o.resumed === true);
    const losers = outcomes.filter((o) => o.resumed === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0];
    if (winner.resumed) {
      expect(winner.operationId).toBe(opId);
      expect(winner.reMerged).toBe(true);
    }
    const loser = losers[0];
    if (!loser.resumed) {
      // The loser either saw a live foreign holder (our re-claim) or an
      // already-terminated slot — both are correct "did not re-merge" outcomes.
      expect(['foreign-live-holder', 'no-lease']).toContain(loser.reason);
    }

    // Exactly ONE terminal landed under the holder's ORIGINAL operationId; the
    // slot ends clear.
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, opId)).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});
