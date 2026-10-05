// Handler-level contract tests for the worktree lifecycle that the dispatch parity suite does not pin.
// They cover the all-or-nothing owner override, exclusive-ownership rejections, and the `ps`, `wait`, and reconcile surfaces.
// The tests run over a real EventStore, and most of them inject fake git, process, and clock seams.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import {
  handleAcquireWorktree,
  handleReconcileWorktrees,
  handleReleaseWorktree,
  handleViewWorktrees,
} from '../../../../src/verbs/worktree/handlers.js';
import { WORKTREES_STREAM, type GitWorktreeProbe } from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource, StartTimeProbe } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type { ProcessTableSource, ProcessRecord } from '../../../../src/verbs/worktree/pure/probe.js';
import type { InFlightMerge, InFlightPrune, WorktreeEntry } from '../../../../src/verbs/worktree/projections/worktrees.js';
import { emitLaunchExecutingStarted, emitLaunchExecuted } from '../../../../src/runtime/launcher/liveness.js';
import { callCli, callMcp } from '../../parity-harness.js';
import { extractSchemaFields } from '../../../../src/adapters/cli/schema-to-flags.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';

/** Empty probe — adopt observes zero on-disk worktrees, no git spawn. */
const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({
    head: null,
    upstream: null,
    mutable: false,
    reason: 'head-unresolved',
  }),
};

/** Fixed, present create-time so reserve is byte-stable and OS-free. */
const FIXED_SOURCE: ProcessSource = {
  getStartTime: (): StartTimeProbe => ({ status: 'present', startedAt: 'fixed-start' }),
};

/**
 * A ProcessSource whose create-time probe never resolves, as on a platform without the probe tool or permission.
 * The derived reservation owner must then fall back to `null`, never `''`.
 */
const UNRESOLVABLE_SOURCE: ProcessSource = {
  getStartTime: (): StartTimeProbe => ({ status: 'unknown' }),
};

const DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

const arms: Arm[] = [];

async function createArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-handlers-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  const arm = { stateDir, ctx };
  arms.push(arm);
  return arm;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (arms.length > 0) {
    const arm = arms.pop();
    if (arm) await rmrfAsync(arm.stateDir);
  }
});

/** `ownerPid` and `ownerStartedAt` must come together or not at all. With neither, the handler derives both. */
describe('resolveOwner all-or-nothing (acquire_worktree)', () => {
  const baseArgs = { repoRoot: '/tmp/wlm-h-repo', worktreeId: '/tmp/wlm-h-wt' };

  it('AcquireWorktree_PartialOwnerOverride_OnlyPid_Rejected', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerPid: 4242 },
      arm.ctx,
      DEPS,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/together/i);
  });

  it('AcquireWorktree_PartialOwnerOverride_OnlyStartedAt_Rejected', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerStartedAt: 'boot-4242' },
      arm.ctx,
      DEPS,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/together/i);
  });

  it('AcquireWorktree_BothOwnerFields_Accepted', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerPid: 4242, ownerStartedAt: 'boot-4242' },
      arm.ctx,
      DEPS,
    );
    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);
  });

  it('AcquireWorktree_NeitherOwnerField_DerivesBoth_Accepted', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(baseArgs, arm.ctx, DEPS);
    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);
  });
});

describe('DR-5 null-ready ownerStartedAt (acquire_worktree)', () => {
  /**
   * With an unresolvable create time, the reservation must store `ownerStartedAt` as `null`, not `''`.
   * The `worktree.reserved` schema rejects `''` through `.min(1)`.
   * The reserve succeeds, the event carries `null`, and the folded projection agrees.
   */
  it('Reserve_UnresolvableCreateTime_StoresNullNeverEmptyString', async () => {
    const arm = await createArm();

    const result = await handleAcquireWorktree(
      { repoRoot: '/tmp/wlm-h-repo', worktreeId: '/tmp/wlm-h-nullstart' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: UNRESOLVABLE_SOURCE },
    );

    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);

    const events = await arm.ctx.eventStore.query(WORKTREES_STREAM);
    const reserved = events.filter((e) => e.type === 'worktree.reserved');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].data?.ownerStartedAt).toBeNull();
    expect(reserved[0].data?.ownerStartedAt).not.toBe('');

    const view = await handleViewWorktrees({}, arm.ctx, {});
    const worktrees = (view.data as { worktrees: WorktreeEntry[] }).worktrees;
    const entry = worktrees.find((w) => w.worktreeId === '/tmp/wlm-h-nullstart');
    expect(entry?.state).toBe('reserved');
    expect(entry?.ownerStartedAt).toBeNull();
  });
});

describe('exclusive ownership (acquire/release handlers)', () => {
  /** Live owner 100 holds the worktree, so owner 200 cannot claim it. */
  it('AcquireWorktree_AlreadyReservedByLiveOwner_ReturnsReservedError', async () => {
    const arm = await createArm();
    const args = {
      repoRoot: '/tmp/wlm-h-repo',
      worktreeId: '/tmp/wlm-h-held',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    };
    const liveSource: ProcessSource = {
      getStartTime: (pid): StartTimeProbe =>
        pid === 100 ? { status: 'present', startedAt: 'boot-100' } : { status: 'absent' },
    };
    const first = await handleAcquireWorktree(args, arm.ctx, {
      gitProbe: EMPTY_PROBE,
      processSource: liveSource,
    });
    expect(first.success).toBe(true);

    const second = await handleAcquireWorktree(
      { ...args, ownerPid: 200, ownerStartedAt: 'boot-200' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('WORKTREE_RESERVED');
  });

  /** Owner 200 cannot release the live reservation of owner 100. */
  it('ReleaseWorktree_ForeignLiveOwner_ReturnsOwnedByOtherError', async () => {
    const arm = await createArm();
    const liveSource: ProcessSource = {
      getStartTime: (pid): StartTimeProbe =>
        pid === 100 ? { status: 'present', startedAt: 'boot-100' } : { status: 'absent' },
    };
    await handleAcquireWorktree(
      {
        repoRoot: '/tmp/wlm-h-repo',
        worktreeId: '/tmp/wlm-h-owned',
        ownerPid: 100,
        ownerStartedAt: 'boot-100',
      },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );

    const release = await handleReleaseWorktree(
      { worktreeId: '/tmp/wlm-h-owned', ownerPid: 200, ownerStartedAt: 'boot-200' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );
    expect(release.success).toBe(false);
    expect(release.error?.code).toBe('WORKTREE_OWNED_BY_OTHER');
  });
});

/** Seed a CLAIM (`worktree.merge_requested`) directly on the singleton stream. */
async function seedMergeRequested(
  arm: Arm,
  holder: {
    integrationRef: string;
    operationId: string;
    sourceBranch: string;
    holderPid: number;
    holderStartedAt: string;
  },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'worktree.merge_requested', data: { ...holder } },
    { idempotencyKey: `worktree.merge_requested:${holder.operationId}` },
  );
}

/** Seed a RELEASE (`worktree.merge_executed`) clearing the slot for `op`. */
async function seedMergeExecuted(
  arm: Arm,
  ref: { integrationRef: string; operationId: string; sourceBranch: string },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'worktree.merge_executed', data: { ...ref } },
    { idempotencyKey: `worktree.merge_executed:${ref.operationId}` },
  );
}

/** Seed a CLAIM (`prune.executing_started`) — a live prune_worktrees GC pass. */
async function seedPruneStarted(
  arm: Arm,
  p: { operationId: string; repoRoot: string; holderPid: number; holderStartedAt: string },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'prune.executing_started', data: { ...p } },
    { idempotencyKey: `prune.executing_started:${p.operationId}` },
  );
}

/** Seed the paired TERMINAL (`prune.executed`) clearing the prune for `op`. */
async function seedPruneExecuted(
  arm: Arm,
  p: { operationId: string; deletedCount: number },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'prune.executed', data: { ...p } },
    { idempotencyKey: `prune.executed:${p.operationId}` },
  );
}

/** Seed a reservation (`worktree.reserved`) for a worktree owned by a PID. */
async function seedReserved(
  arm: Arm,
  r: {
    worktreeId: string;
    path: string;
    ownerPid: number;
    ownerStartedAt: string;
    operationId: string;
  },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    {
      type: 'worktree.reserved',
      data: {
        worktreeId: r.worktreeId,
        path: r.path,
        featureId: null,
        ownerPid: r.ownerPid,
        ownerStartedAt: r.ownerStartedAt,
        operationId: r.operationId,
      },
    },
    { idempotencyKey: `worktree.reserved:${r.operationId}` },
  );
}

/**
 * Each `ps` call passes `scope: 'worktree'`, the scope that returns the worktree liveness fold.
 * The `ps` calls go through `handleView`, so a missing routing arm fails them.
 * Fake process tables and an identity `realpath` keep the tests free of OS process scans.
 */
describe('ps — in-flight liveness read (DR-4)', () => {
  /** `ps` lists an in-flight merge from events and never reads the process table. */
  it('HandleView_Ps_ListsInFlightFromInFlightMerges_NoProcessScan', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-ps',
      sourceBranch: 'feat/x',
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    const listSpy = vi.fn((): readonly ProcessRecord[] => []);
    const table: ProcessTableSource = { list: listSpy };

    const result = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, {
      processTableSource: table,
      realpath: (p) => p,
    });

    expect(result.success).toBe(true);
    const data = result.data as { inFlight: InFlightMerge[]; count: number };
    expect(data.count).toBe(1);
    expect(data.inFlight[0].integrationRef).toBe('main');
    expect(data.inFlight[0].sourceBranch).toBe('feat/x');
    expect(listSpy).not.toHaveBeenCalled();
  });

  /**
   * Owners 555 and 666 are absent from the process table, so they are dead.
   * PID 777 is alive with its cwd inside the orphan worktree, so that worktree gets `worktree.orphan_detected`.
   * The released worktree has no occupant, so it gets `worktree.released`.
   * `selfPid` 999999 is not in the table, so its ancestry is only itself and 777 counts as a foreign occupant.
   */
  it('ReconcileWorktrees_DeadOwners_ReleasedAndOrphanedEmitted', async () => {
    const arm = await createArm();
    await seedReserved(arm, {
      worktreeId: '/wlm/released-wt',
      path: '/wlm/released-wt',
      ownerPid: 555,
      ownerStartedAt: 'b555',
      operationId: 'op-rel',
    });
    await seedReserved(arm, {
      worktreeId: '/wlm/orphan-wt',
      path: '/wlm/orphan-wt',
      ownerPid: 666,
      ownerStartedAt: 'b666',
      operationId: 'op-orph',
    });

    const table: ProcessTableSource = {
      list: () => [{ pid: 777, ppid: 1, cwd: '/wlm/orphan-wt/sub', startTime: 'b777' }],
    };

    const result = await handleReconcileWorktrees({}, arm.ctx, {
      processTableSource: table,
      realpath: (p) => p,
      selfPid: 999999,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      probe: { released: string[]; orphaned: string[]; probed: number };
    };
    expect(data.probe.probed).toBe(2);
    expect(data.probe.released).toContain('/wlm/released-wt');
    expect(data.probe.orphaned).toContain('/wlm/orphan-wt');

    const events = await arm.ctx.eventStore.query(WORKTREES_STREAM);
    const types = events.map((e) => e.type);
    expect(types).toContain('worktree.released');
    expect(types).toContain('worktree.orphan_detected');
  });

  /**
   * The launcher reserves its worktree, and then a child starts.
   * `ps` shows the launch from events with no process scan, and clears it after `launch.executed` folds.
   */
  it('HandleView_Ps_SurfacesInFlightLaunches_ClearedByTerminal', async () => {
    const arm = await createArm();
    await seedReserved(arm, {
      worktreeId: '/wlm/launch-wt',
      path: '/wlm/launch-wt',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
      operationId: 'op-launch',
    });
    await emitLaunchExecutingStarted(arm.ctx.eventStore, {
      worktreeId: '/wlm/launch-wt',
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });

    const listSpy = vi.fn((): readonly ProcessRecord[] => []);
    const inFlightResult = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, {
      processTableSource: { list: listSpy },
      realpath: (p) => p,
    });
    expect(inFlightResult.success).toBe(true);
    const inFlightData = inFlightResult.data as {
      launches: WorktreeEntry[];
      launchCount: number;
    };
    expect(inFlightData.launchCount).toBe(1);
    expect(inFlightData.launches[0].worktreeId).toBe('/wlm/launch-wt');
    expect(inFlightData.launches[0].launch).toEqual({
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });
    expect(listSpy).not.toHaveBeenCalled();

    await emitLaunchExecuted(arm.ctx.eventStore, {
      worktreeId: '/wlm/launch-wt',
      exitCode: 0,
    });
    const clearedResult = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, {
      realpath: (p) => p,
    });
    const clearedData = clearedResult.data as {
      launches: WorktreeEntry[];
      launchCount: number;
    };
    expect(clearedData.launchCount).toBe(0);
    expect(clearedData.launches).toEqual([]);
  });

  /**
   * The supervisor died with no teardown, so no `launch.executed` exists and `ps` folds the launch as in-flight.
   * A supported, empty process table makes the holder provably dead. `ps` is a read and leaves the phantom alone.
   * The reconcile runs the reservation reclaim and writes one `launch.executed` in the same call.
   * Its response must report the launch column after the heal, so a healed phantom is not also in-flight.
   * The test calls the handler directly, because the orchestrate composite does not pass the process-table seam.
   */
  it('ReconcileWorktrees_PhantomLaunch_HealedToTerminal', async () => {
    const arm = await createArm();
    await seedReserved(arm, {
      worktreeId: '/wlm/phantom-launch-wt',
      path: '/wlm/phantom-launch-wt',
      ownerPid: 8881,
      ownerStartedAt: 'boot-8881',
      operationId: 'op-phantom',
    });
    await emitLaunchExecutingStarted(arm.ctx.eventStore, {
      worktreeId: '/wlm/phantom-launch-wt',
      holderPid: 8882,
      holderStartedAt: 'boot-8882',
    });

    const table: ProcessTableSource = { list: () => [], isSupported: () => true };

    const before = (await arm.ctx.eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'launch.executed',
    );
    expect(before).toHaveLength(0);

    const psBefore = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, {
      processTableSource: table,
      realpath: (p) => p,
    });
    expect((psBefore.data as { launchCount: number }).launchCount).toBe(1);

    const result = await handleReconcileWorktrees({}, arm.ctx, {
      processTableSource: table,
      realpath: (p) => p,
      selfPid: 999999,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      reconcile: { reconciled: string[]; leftInFlight: string[]; probed: number };
      probe: { probed: number };
      launches: unknown[];
      launchCount: number;
    };
    expect(data.probe).toBeDefined();
    expect(data.reconcile.reconciled).toContain('/wlm/phantom-launch-wt');

    expect(data.launchCount).toBe(0);
    expect(data.launches).toHaveLength(0);

    const after = (await arm.ctx.eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'launch.executed',
    );
    expect(after).toHaveLength(1);
    expect(after[0].data?.worktreeId).toBe('/wlm/phantom-launch-wt');

    const cleared = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, { realpath: (p) => p });
    expect((cleared.data as { launchCount: number }).launchCount).toBe(0);
  });
});

describe('wait — caller-bounded merge-terminal poll (DR-4)', () => {
  /** With no holder, the slot is already terminal, so the wait resolves on the first fold with no sleep. */
  it('HandleView_Wait_AlreadyTerminal_ResolvesImmediately', async () => {
    const arm = await createArm();
    const sleep = vi.fn(async () => {});

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 5_000 },
      arm.ctx,
      { sleep },
    );

    expect(result.success).toBe(true);
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  /** The injected sleep clears the slot on its first call, so the next fold resolves with no real timer. */
  it('HandleView_Wait_InFlightThenTerminal_ResolvesWithinTimeout', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-wait',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await seedMergeExecuted(arm, {
          integrationRef: 'main',
          operationId: 'op-wait',
          sourceBranch: 'feat/x',
        });
      }
    });

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 10_000 },
      arm.ctx,
      { sleep },
    );

    expect(result.success).toBe(true);
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  /** Each instant sleep moves the clock past the deadline, so the poll ends with a structured timeout. */
  it('HandleView_Wait_Timeout_ReturnsStructuredTimeoutNotHang', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-stuck',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let t = 0;
    const now = (): number => t;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 100 },
      arm.ctx,
      { now, sleep, pollIntervalMs: 200 },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_TIMEOUT');
    const data = result.data as {
      reason: string;
      integrationRef: string;
      timeoutMs: number;
    };
    expect(data.reason).toBe('wait-timeout');
    expect(data.integrationRef).toBe('main');
    expect(data.timeoutMs).toBe(100);
  });

  /** The injected sleep clears the slot on the first poll, so the wait creates no real `setTimeout` or `setInterval`. */
  it('Manager_NoBackgroundTimer_SetIntervalSpyZeroCalls', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-timer',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const beforeInterval = setIntervalSpy.mock.calls.length;
    const beforeTimeout = setTimeoutSpy.mock.calls.length;

    const sleep = vi.fn(async () => {
      await seedMergeExecuted(arm, {
        integrationRef: 'main',
        operationId: 'op-timer',
        sourceBranch: 'feat/x',
      });
    });

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 10_000 },
      arm.ctx,
      { sleep },
    );
    expect(result.success).toBe(true);

    expect(setIntervalSpy.mock.calls.length - beforeInterval).toBe(0);
    expect(setTimeoutSpy.mock.calls.length - beforeTimeout).toBe(0);
  });
});

/** The `worktrees@v1` projection folds the `prune.executing_started` and `prune.executed` pair into `inFlightPrunes`. */
describe('ps — in-flight prune surface (DR-3)', () => {
  /** `ps` lists the in-flight prune from the fold without reading the process table, and clears it after the terminal folds. */
  it('PruneWorktrees_InFlight_VisibleViaPs', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-prune',
      repoRoot: '/wlm/repo',
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    const listSpy = vi.fn((): readonly ProcessRecord[] => []);
    const result = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, {
      processTableSource: { list: listSpy },
      realpath: (p) => p,
    });

    expect(result.success).toBe(true);
    const data = result.data as { prunes: InFlightPrune[]; pruneCount: number };
    expect(data.pruneCount).toBe(1);
    expect(data.prunes[0].operationId).toBe('op-prune');
    expect(data.prunes[0].repoRoot).toBe('/wlm/repo');
    expect(data.prunes[0].holderPid).toBe(4242);
    expect(listSpy).not.toHaveBeenCalled();

    await seedPruneExecuted(arm, { operationId: 'op-prune', deletedCount: 0 });
    const cleared = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, { realpath: (p) => p });
    const clearedData = cleared.data as { prunes: InFlightPrune[]; pruneCount: number };
    expect(clearedData.pruneCount).toBe(0);
    expect(clearedData.prunes).toEqual([]);
  });
});

describe("wait — until: 'idle' prune-idle poll (DR-3)", () => {
  /** The injected sleep appends the prune terminal on its first call, so the next fold finds no in-flight prune and resolves. */
  it('Wait_UntilIdle_ResolvesOnPruneTerminal', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-idle',
      repoRoot: '/wlm/repo',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await seedPruneExecuted(arm, { operationId: 'op-idle', deletedCount: 3 });
      }
    });

    const result = await handleView(
      { action: 'wait', until: 'idle', timeoutMs: 10_000 },
      arm.ctx,
      { sleep },
    );

    expect(result.success).toBe(true);
    const data = result.data as { until: string; resolved: boolean };
    expect(data.until).toBe('idle');
    expect(data.resolved).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  /** The prune pass never ends, so the poll ends with a structured timeout that names the holder. */
  it('Wait_UntilIdle_Timeout_StructuredNotHang', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-stuck-prune',
      repoRoot: '/wlm/repo',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let t = 0;
    const now = (): number => t;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });

    const result = await handleView(
      { action: 'wait', until: 'idle', timeoutMs: 100 },
      arm.ctx,
      { now, sleep, pollIntervalMs: 200 },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_TIMEOUT');
    const data = result.data as {
      reason: string;
      timeoutMs: number;
      holders: Array<{ operationId: string; repoRoot: string; holderPid: number | null }>;
    };
    expect(data.reason).toBe('wait-idle-timeout');
    expect(data.timeoutMs).toBe(100);
    expect(data.holders).toHaveLength(1);
    expect(data.holders[0].operationId).toBe('op-stuck-prune');
    expect(data.holders[0].repoRoot).toBe('/wlm/repo');
  });
});

describe("wait — until: 'idle' CLI/MCP flag parity (DR-3, task-021)", () => {
  /**
   * The CLI and MCP facades derive `until` from one registry schema, so this pins its enum values and optionality.
   * It then runs `wait until: 'idle'` through both facades with their real deps.
   * The store has no in-flight prune, so the wait resolves on the first fold with no real timer.
   */
  it('WaitSchema_UntilIdleFlag_ParityCliMcp', async () => {
    const waitAction = TOOL_REGISTRY
      .find((t) => t.name === 'exarchos_view')!
      .actions.find((a) => a.name === 'wait')!;
    const untilField = extractSchemaFields(waitAction.schema).find(
      (f) => f.name === 'until',
    );
    expect(untilField).toBeDefined();
    expect(untilField!.type).toBe('enum');
    expect(untilField!.enumValues).toEqual(['merge', 'idle']);
    expect(untilField!.required).toBe(false);

    const cliArm = await createArm();
    const mcpArm = await createArm();

    const { result: cliResult } = await callCli(cliArm.ctx, 'vw', 'wait', {
      until: 'idle',
      timeoutMs: 1_000,
    });
    const mcpResult = await callMcp(mcpArm.ctx, 'exarchos_view', {
      action: 'wait',
      until: 'idle',
      timeoutMs: 1_000,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    const cliData = cliResult.data as { until: string; resolved: boolean };
    const mcpData = mcpResult.data as { until: string; resolved: boolean };
    expect(cliData.until).toBe('idle');
    expect(mcpData.until).toBe('idle');
    expect(cliData.resolved).toBe(true);
    expect(mcpData.resolved).toBe(true);
  });
});
