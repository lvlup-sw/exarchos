// ─── DR-12 — error handling & failure modes for the liveness + merge surface ──
//
// The crash / concurrency recovery edges that the Task-006 lease loop and the
// Task-007 prune ladder do NOT cover on their own:
//
//   1. Crash-mid-merge recovery — an unpaired `worktree.merge_requested` (a
//      crash between CLAIM and RELEASE) whose holder is provably dead is
//      terminated EXACTLY ONCE (INV-8/13) by FREEING the dead slot, from either
//      production path: the LIVE inline dead-holder reclaim reached via the
//      `serialize_merge` action, OR the explicit `reconcileMerges` pass wired into
//      the `ps --probe` reconcile handler alongside the reservation + launch
//      reconcilers. There is no standalone resume entry (DR-3, WLM slice 3: the
//      built-but-unwired `resumeCrashedMerge` export — which re-ran the crashed
//      merge under the caller's `featureId` — was excised in favor of these two
//      slot-freeing paths).
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

import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

import { serializeMerge } from './merge-serializer.js';
import { handleSerializeMerge } from './handlers.js';
import { handleView } from '../../projections/views/composite.js';
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

// ─── Test 1: crash-mid-merge recovered from the production serialize_merge path ─

describe('DR-12 — crash-mid-merge recovery via the production serialize_merge path', () => {
  it('Recovery_MergeRequestedNoExecuted_ResumeEmitsSingleExecuted', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/resume';
    const crashedOpId = 'crashed-op';
    // A crash between the CLAIM (`worktree.merge_requested`) and the RELEASE: an
    // unpaired lease whose holder pid (4242) is absent from the SUPPORTED table →
    // provably dead. There is NO standalone resume entry (DR-3: `resumeCrashedMerge`
    // was excised) — recovery must ride the LIVE inline dead-holder reclaim in
    // `waitForFreeSlot`, reached from the registered production `serialize_merge`
    // action handler.
    await seedHolder(arm, {
      integrationRef,
      operationId: crashedOpId,
      sourceBranch: 'feat/crashed',
      holderPid: 4242,
      holderStartedAt: 'gone-4242',
    });

    const merged: string[] = [];
    // Drive the REGISTERED production entry point (`handleSerializeMerge`), NOT the
    // module-internal `serializeMerge` — a caller-level recovery proof. A live new
    // claimant (111) merges into the SAME integration ref; the crashed holder
    // (4242) is absent from the table → reclaimed inline before the merge runs.
    const result = await handleSerializeMerge(
      // dryRun:false — serialize_merge now DEFAULTS to dry-run (DR-1); this crash-
      // recovery proof needs the real apply path (lease claim + composed merge).
      { featureId: 'F', integrationRef, sourceBranch: 'feat/next', strategy: 'merge', timeoutMs: 30_000, dryRun: false },
      arm.ctx,
      {
        selfPid: 111,
        selfStartedAt: 'self-111',
        processTableSource: liveTable([{ pid: 111, startTime: 'self-111' }]), // 4242 absent → dead.
        // `sleep` throwing proves the reclaim was INLINE — the crashed holder is
        // freed on the first fold, never waited out against the 30s budget.
        sleep: async () => {
          throw new Error('crash recovery must not wait out the budget');
        },
        mergeOrchestrate: async (input) => {
          merged.push(input.featureId);
          return { success: true, data: { phase: 'completed' } };
        },
        readIntegrationHead: () => null,
      },
    );

    expect(result.success).toBe(true);
    // THE crash-resume guarantee: the stranded lease was terminated EXACTLY ONCE
    // under its ORIGINAL operationId by the inline reclaim (INV-8/13 exactly-once,
    // a keyed append that dedups across any racing reclaim).
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, crashedOpId)).toHaveLength(1);
    // The freed slot then carried the next merge, which ran and released — the
    // slot ends clear (no wedge).
    expect(merged).toEqual(['F']);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

// ─── Test 1b: crash recovered from the EXPLICIT ps --probe reconcile pass ─────

describe('DR-3 — crash-mid-merge reconciled from the ps --probe production entry', () => {
  it('CrashedMerge_RecoveredFromProductionEntryPoint_ExactlyOneTerminalEvent', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/ps-reconcile';
    const crashedOpId = 'crashed-op';
    // A stranded lease whose holder pid (4242) is absent from the SUPPORTED table
    // → provably dead. NO subsequent `serialize_merge` runs on this ref, so the
    // inline reclaim never fires — the explicit `reconcileMerges` pass wired into
    // `ps --probe` must free it (the crashed-lease sibling of the reservation +
    // launch reconcilers). Recovery is proven from the PUBLIC composite view
    // entry (`handleView` → exarchos_view `ps`), a caller-level path.
    await seedHolder(arm, {
      integrationRef,
      operationId: crashedOpId,
      sourceBranch: 'feat/crashed',
      holderPid: 4242,
      holderStartedAt: 'gone-4242',
      worktreeId: '/wlm/ps-reconcile-wt',
    });

    const result = await handleView(
      { action: 'ps', scope: 'worktree', probe: true },
      arm.ctx,
      { processTableSource: EMPTY_TABLE, selfPid: 999999, realpath: (p) => p },
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      inFlight: unknown[];
      count: number;
      mergeReconcile: { reconciled: string[]; leftInFlight: string[]; probed: number };
    };
    // The crashed lease was reconciled to a terminal on THIS pass...
    expect(data.mergeReconcile.probed).toBe(1);
    expect(data.mergeReconcile.reconciled).toContain(integrationRef);
    expect(data.mergeReconcile.leftInFlight).toEqual([]);
    // ...and the POST-reconcile in-flight column reflects the freed slot (not a
    // stale pre-reconcile snapshot reporting it as both in-flight AND reconciled).
    expect(data.inFlight).toEqual([]);
    expect(data.count).toBe(0);

    // EXACTLY ONE terminal landed under the holder's ORIGINAL operationId; the
    // slot folds clear (INV-8/13 exactly-once).
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, crashedOpId)).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });

  it('CrashedMerge_LiveHolder_PsProbeLeavesLeaseInFlight_FailClosed', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/ps-live';
    // A LIVE holder (pid 7777 present in the table) — an ACTIVE merge, not a
    // crash. The reconcile must NEVER steal a live lease: fail closed, left
    // in-flight, no terminal emitted.
    await seedHolder(arm, {
      integrationRef,
      operationId: 'live-op',
      sourceBranch: 'feat/live',
      holderPid: 7777,
      holderStartedAt: 'alive-7777',
    });

    const result = await handleView(
      { action: 'ps', scope: 'worktree', probe: true },
      arm.ctx,
      {
        processTableSource: liveTable([{ pid: 7777, startTime: 'alive-7777' }]),
        selfPid: 999999,
        realpath: (p) => p,
      },
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      inFlight: Array<{ integrationRef: string }>;
      mergeReconcile: { reconciled: string[]; leftInFlight: string[]; probed: number };
    };
    expect(data.mergeReconcile.reconciled).toEqual([]);
    expect(data.mergeReconcile.leftInFlight).toContain(integrationRef);
    // The live lease is still reported in-flight and never terminated.
    expect(data.inFlight.map((m) => m.integrationRef)).toContain(integrationRef);
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, 'live-op')).toHaveLength(0);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]?.operationId).toBe('live-op');
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
});

// ─── Test 3: concurrent prune + merge — prune skips an in-flight lease ────────

// skipIf(win32): unlike the sibling DR-12 describes (which inject EMPTY_TABLE /
// liveTable / UNSUPPORTED_TABLE), this one builds WorktreeManager with the DEFAULT
// process table, whose win32 enumeration (Get-CimInstance, DR-5) is nondeterministic
// on the shared CI runner and flips the prune occupancy verdict at random. Gated off
// win32 until #1641 injects a deterministic ProcessTableSource; Linux coverage
// unchanged. The other DR-12 describes keep running on win32 (deterministic tables).
describe.skipIf(process.platform === 'win32')('DR-12 — concurrent prune + merge', () => {
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

// The former Test 7 (`Recovery_TwoConcurrentResumes_OccPreventsDoubleMerge`)
// guarded the standalone `resumeCrashedMerge` re-merge against a concurrent
// double-apply. That export was excised (DR-3, WLM slice 3): neither slot-freeing
// recovery path (the inline dead-holder reclaim nor the explicit `reconcileMerges`
// pass) re-runs the crashed merge — each frees the dead slot so the next live
// claimant runs its OWN correctly-attributed merge — so there is no double-merge
// hazard to guard and the test has no subject under the excised model.
