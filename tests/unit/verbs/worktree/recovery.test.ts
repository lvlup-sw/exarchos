// Recovery tests for the crash and concurrency paths of the liveness and merge surface.
// A crashed merge leaves an unpaired `worktree.merge_requested`.
// When its holder is provably dead, recovery frees the slot with exactly one terminal event.
// Two production paths free it: the inline dead-holder reclaim in `serialize_merge`, and the `reconcileMerges` pass in `reconcile_worktrees`.
// Prune skips a worktree whose integration branch holds an in-flight merge lease.
// An exhausted index.lock retry reaches the caller as `IndexLockContentionError`, and the lease is released.
//
// The serializer runs no `git reset --hard` and passes a `recoveryError` from `merge_orchestrate` through unchanged.
// The tests use a real SQLite EventStore, because its stream-version check inside the transaction is the cross-process guard.
// The prune test also uses a real git repo.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { rmrfAsync, rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

import { serializeMerge } from '../../../../src/verbs/worktree/merge-serializer.js';
import { handleReconcileWorktrees, handleSerializeMerge } from '../../../../src/verbs/worktree/handlers.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from '../../../../src/verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';
import type { ProcessTableSource, ProcessRecord } from '../../../../src/verbs/worktree/pure/probe.js';
import type { ProcessSource, StartTimeProbe } from '../../../../src/verbs/worktree/pure/process-identity.js';
import { IndexLockContentionError, type SleepFn } from '../../../../src/verbs/worktree/git-retry.js';
import { canonicalWorktreeId } from '../../../../src/verbs/worktree/pure/path-containment.js';

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
    if (dir) rmrf(dir);
  }
});

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
 * An unsupported process table, the shape of the default source on a platform with no process enumerator.
 * `list()` is empty and `isSupported()` is `false`, so a probed PID reads as `'unknown'`, never provably dead.
 * Reclaim consumers must fail closed against it.
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

describe('DR-12 — crash-mid-merge recovery via the production serialize_merge path', () => {
  /**
   * A crash leaves an unpaired claim, and holder 4242 is absent from the supported table, so it is provably dead.
   * The test calls the registered `handleSerializeMerge` with `dryRun: false`, because the action defaults to a dry run.
   * Live claimant 111 merges into the same ref.
   * The inline reclaim in `waitForFreeSlot` frees the dead slot on the first fold, and `sleep` throws to prove it.
   * The stranded lease gets exactly one terminal under its original `operationId`, the next merge runs, and the slot ends clear.
   */
  it('Recovery_MergeRequestedNoExecuted_ResumeEmitsSingleExecuted', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/resume';
    const crashedOpId = 'crashed-op';
    await seedHolder(arm, {
      integrationRef,
      operationId: crashedOpId,
      sourceBranch: 'feat/crashed',
      holderPid: 4242,
      holderStartedAt: 'gone-4242',
    });

    const merged: string[] = [];
    const result = await handleSerializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/next', strategy: 'merge', timeoutMs: 30_000, dryRun: false },
      arm.ctx,
      {
        selfPid: 111,
        selfStartedAt: 'self-111',
        processTableSource: liveTable([{ pid: 111, startTime: 'self-111' }]),
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
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, crashedOpId)).toHaveLength(1);
    expect(merged).toEqual(['F']);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

describe('DR-3 — crash-mid-merge reconciled from the reconcile_worktrees production entry', () => {
  /**
   * Holder 4242 is absent from the supported table, and no later `serialize_merge` runs on the ref, so the inline reclaim never fires.
   * The `reconcileMerges` pass in `handleReconcileWorktrees` must free the lease with exactly one terminal under its original `operationId`.
   * The response reports the in-flight column after the reconcile, so the freed slot is not also in-flight.
   */
  it('CrashedMerge_RecoveredFromProductionEntryPoint_ExactlyOneTerminalEvent', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/ps-reconcile';
    const crashedOpId = 'crashed-op';
    await seedHolder(arm, {
      integrationRef,
      operationId: crashedOpId,
      sourceBranch: 'feat/crashed',
      holderPid: 4242,
      holderStartedAt: 'gone-4242',
      worktreeId: '/wlm/ps-reconcile-wt',
    });

    const result = await handleReconcileWorktrees(
      {},
      arm.ctx,
      { processTableSource: EMPTY_TABLE, selfPid: 999999, realpath: (p) => p },
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      inFlight: unknown[];
      count: number;
      mergeReconcile: { reconciled: string[]; leftInFlight: string[]; probed: number };
    };
    expect(data.mergeReconcile.probed).toBe(1);
    expect(data.mergeReconcile.reconciled).toContain(integrationRef);
    expect(data.mergeReconcile.leftInFlight).toEqual([]);
    expect(data.inFlight).toEqual([]);
    expect(data.count).toBe(0);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, crashedOpId)).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });

  /** Holder 7777 is live, so the merge is active. The reconcile must not take the lease, which stays in-flight with no terminal. */
  it('CrashedMerge_LiveHolder_ReconcileLeavesLeaseInFlight_FailClosed', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/ps-live';
    await seedHolder(arm, {
      integrationRef,
      operationId: 'live-op',
      sourceBranch: 'feat/live',
      holderPid: 7777,
      holderStartedAt: 'alive-7777',
    });

    const result = await handleReconcileWorktrees(
      {},
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
    expect(data.inFlight.map((m) => m.integrationRef)).toContain(integrationRef);
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, 'live-op')).toHaveLength(0);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]?.operationId).toBe('live-op');
  });
});

describe('DR-12 — stale dead-holder reclamation', () => {
  /**
   * Holder 9090 is absent from the empty table, so it is provably dead.
   * `sleep` throws and the clock never moves, so the reclaim happens inline and spends none of the budget.
   * The dead holder gets its terminal under its own `operationId`, and the slot ends clear.
   */
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
        processTableSource: EMPTY_TABLE,
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
    expect(clock).toBe(0);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(executedFor(events, 'dead-op')).toHaveLength(1);
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

/**
 * Skipped on win32. This suite uses the default process table, and its win32 enumeration is nondeterministic on the shared CI runner (#1641).
 * The other suites in this file inject fixed tables and run on win32.
 */
describe.skipIf(process.platform === 'win32')('DR-12 — concurrent prune + merge', () => {
  async function git(cwd: string, args: readonly string[]): Promise<string> {
    return (await execFileAsync('git', args, { cwd })).trim();
  }

  async function initRepoWithOrigin(workdir: string, name: string): Promise<string> {
    const origin = path.join(workdir, `${name}-origin.git`);
    await git(workdir, ['init', '-q', '--bare', origin]);
    const repo = path.join(workdir, name);
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '-b', 'work']);
    await git(repo, ['config', 'user.email', 'wlm@example.com']);
    await git(repo, ['config', 'user.name', 'WLM Test']);
    await git(repo, ['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(repo, 'README.md'), '# wlm recovery prune\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    const real = realpathSync(repo);
    await git(real, ['remote', 'add', 'origin', origin]);
    await git(real, ['push', '-q', 'origin', 'work']);
    return real;
  }

  /**
   * The released worktree is clean, merged, and has a reachable origin, so it is otherwise delete-eligible.
   * A live merge holds the lease on the same integration branch with no `worktreeId`, as the serializer writes it.
   * The integration-ref match must catch it. Prune skips it as `in-flight-merge` and writes no `worktree.remove.requested` for it.
   */
  it('Recovery_ConcurrentPruneAndMerge_PruneSkipsBranchWithInFlightLease', async () => {
    const arm = await createArm();
    const workdir = await mkdtemp(path.join(tmpdir(), 'wlm-recovery-work-'));
    repoDirs.push(workdir);

    const repo = await initRepoWithOrigin(workdir, 'repo');
    const integrationRef = 'feat/integ';
    await git(repo, ['branch', integrationRef]);
    const wtPath = path.join(workdir, 'wt-merging');
    await git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'wbranch']);
    const wtId = canonicalWorktreeId(wtPath);

    await arm.eventStore.append('feat-merge', {
      type: 'state.patched',
      data: { patch: { 'synthesis.integrationBranch': integrationRef } },
    });

    const manager = new WorktreeManager({ eventStore: arm.eventStore });
    await manager.reserve({
      worktreeId: wtId,
      path: wtPath,
      featureId: 'feat-merge',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });
    await manager.release(wtId);

    await seedHolder(arm, {
      integrationRef,
      operationId: 'merge-in-flight',
      sourceBranch: 'wbranch',
      holderPid: 7777,
      holderStartedAt: 'alive-7777',
    });

    const result = await manager.prune({ repoRoot: repo, apply: true });

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'in-flight-merge' });
    expect(result.deleted).not.toContain(wtId);
    expect(result.skipsByReason['in-flight-merge']).toContain(wtId);
    const removeReqs = (await arm.eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'worktree.remove.requested' &&
        (e.data as { worktreeId?: unknown }).worktreeId === wtId,
    );
    expect(removeReqs).toHaveLength(0);
    expect((await foldWorktrees(arm)).worktrees[wtId]?.state).toBe('released');
  });
});

describe('DR-12 — exhausted index.lock retry', () => {
  /**
   * The index.lock retry kernel sits in `defaultGitExec` and has its own tests, so this test does not run it.
   * It injects a terminal `IndexLockContentionError` through `mergeOrchestrate`.
   * The serializer must pass the error to the caller unchanged and still release the lease in `finally`, so no half-merge stays.
   */
  it('Recovery_ExhaustedIndexLockRetry_SurfacesStructuredErrorNoHalfMerge', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/locked';

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

    expect(caught).toBe(lockErr);
    expect(caught).toBeInstanceOf(IndexLockContentionError);
    expect((caught as IndexLockContentionError).code).toBe('INDEX_LOCK_CONTENTION');

    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const claims = events.filter((e) => e.type === 'worktree.merge_requested');
    const releases = events.filter((e) => e.type === 'worktree.merge_executed');
    expect(claims).toHaveLength(1);
    expect(releases).toHaveLength(1);
  });
});

describe('DR-12 — no reset --hard, INV-14 pass-through', () => {
  /**
   * The serializer source holds no `reset` or `--hard`. The test removes comments first, so a comment that names `--hard` cannot fail the check.
   * The line-comment pattern keeps `://` in URLs.
   * When `merge_orchestrate` reverses a merge and returns a `recoveryError`, the serializer passes the result through unchanged and releases the lease.
   */
  it('Recovery_SerializerIntroducesNoResetHard_SurfacesRecoveryErrorFromMergeOrchestrate', async () => {
    const sourcePath = fileURLToPath(new URL('../../../../src/verbs/worktree/merge-serializer.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf-8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/--hard/i);
    expect(code).not.toMatch(/\breset\b/i);

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
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

describe('DR-12 — unsupported process table fails closed (REV-H1)', () => {
  /**
   * Owner 4242 is absent from the table. A supported table makes that owner provably dead, but here it reads `'unknown'`.
   * The probe must then append no event, and the reservation stays.
   */
  it('ProbeAndReclaim_UnsupportedTable_EmitsNoEvents', async () => {
    const arm = await createArm();
    const manager = new WorktreeManager({
      eventStore: arm.eventStore,
      processTableSource: UNSUPPORTED_TABLE,
    });

    const wtId = '/wlm/unsupported-wt';
    await manager.reserve({
      worktreeId: wtId,
      path: wtId,
      featureId: 'F',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });

    const before = (await arm.eventStore.query(WORKTREES_STREAM)).length;
    const result = await manager.probeAndReclaim(999999);

    expect(result.released).toEqual([]);
    expect(result.orphaned).toEqual([]);
    expect(result.probed).toBe(1);
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(events.length).toBe(before);
    expect(events.some((e) => e.type === 'worktree.released')).toBe(false);
    expect(events.some((e) => e.type === 'worktree.orphan_detected')).toBe(false);
    expect((await foldWorktrees(arm)).worktrees[wtId]?.state).toBe('reserved');
  });
});

describe('probeAndReclaim — per-entry fault isolation', () => {
  /**
   * The empty, supported table makes both owners provably dead.
   * The spy fails only the release append for the first worktree. `withStateRetry` does not retry a generic `Error`, so it propagates at once.
   * The pass must not throw. It reports only the worktree whose event landed, and the failed one stays `reserved` for the next pass.
   */
  it('ProbeAndReclaim_OneReleaseAppendThrows_RemainingStillReclaimed', async () => {
    const arm = await createArm();
    const manager = new WorktreeManager({
      eventStore: arm.eventStore,
      processTableSource: EMPTY_TABLE,
    });
    const wtFail = '/wlm/reclaim-fails';
    const wtOk = '/wlm/reclaim-succeeds';
    await manager.reserve({ worktreeId: wtFail, path: wtFail, featureId: 'F', ownerPid: 4242, ownerStartedAt: 'boot-4242' });
    await manager.reserve({ worktreeId: wtOk, path: wtOk, featureId: 'F', ownerPid: 4343, ownerStartedAt: 'boot-4343' });

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

    const result = await manager.probeAndReclaim(999999);
    appendSpy.mockRestore();

    expect(result.probed).toBe(2);
    expect(result.released).toContain(wtOk);
    expect(result.released).not.toContain(wtFail);
    expect(result.orphaned).toEqual([]);

    const projection = await foldWorktrees(arm);
    expect(projection.worktrees[wtFail]?.state).toBe('reserved');
    expect(projection.worktrees[wtOk]?.state).toBe('released');
  });
});
