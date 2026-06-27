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

/** Empty process table — every probed pid reads as absent (provably dead). */
const EMPTY_TABLE: ProcessTableSource = { list: () => [] };

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

    // merge_orchestrate's DR-8 retry seam exhausts and throws the structured
    // contention error (the serializer composes merge_orchestrate UNCHANGED).
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
