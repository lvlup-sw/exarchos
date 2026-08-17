// ─── Worktree-lifecycle handler contract tests ───────────────────────────────
//
// Focused on the handler-level invariants the dispatch/parity suite does not
// pin: the all-or-nothing owner override (fix 6) and the exclusive-ownership
// rejections wired from the manager (fix 4). Every handler is driven directly
// over a real EventStore with deterministic injected deps (no git spawn, no OS
// process probe), so the assertions are platform-free.

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

// ─── Deterministic injected deps ─────────────────────────────────────────────

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
 * A ProcessSource whose create-time probe can NEVER resolve (permission error /
 * missing tool / unsupported platform) — models the DR-5 create-time-unresolvable
 * platform so the derived reservation owner must fall back to `null`, never `''`.
 */
const UNRESOLVABLE_SOURCE: ProcessSource = {
  getStartTime: (): StartTimeProbe => ({ status: 'unknown' }),
};

const DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

// ─── Arm ─────────────────────────────────────────────────────────────────────

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

// ─── fix 6: all-or-nothing owner override ────────────────────────────────────

describe('resolveOwner all-or-nothing (acquire_worktree)', () => {
  const baseArgs = { repoRoot: '/tmp/wlm-h-repo', worktreeId: '/tmp/wlm-h-wt' };

  it('AcquireWorktree_PartialOwnerOverride_OnlyPid_Rejected', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerPid: 4242 }, // ownerStartedAt omitted → partial
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
      { ...baseArgs, ownerStartedAt: 'boot-4242' }, // ownerPid omitted → partial
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

// ─── DR-5: null-ready ownerStartedAt (never the empty string) ─────────────────

describe('DR-5 null-ready ownerStartedAt (acquire_worktree)', () => {
  it('Reserve_UnresolvableCreateTime_StoresNullNeverEmptyString', async () => {
    const arm = await createArm();

    // Derive the owner from the current process on a platform whose create-time
    // probe cannot resolve — the reservation must persist ownerStartedAt as null,
    // NOT the empty string. A `''` would trip the schema's `.min(1)` and never
    // fold into a matchable owner (the invalid-raw-event class DR-5 closes).
    const result = await handleAcquireWorktree(
      { repoRoot: '/tmp/wlm-h-repo', worktreeId: '/tmp/wlm-h-nullstart' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: UNRESOLVABLE_SOURCE },
    );

    // The reserve SUCCEEDS (a well-formed reservation) rather than throwing on a
    // schema-rejected empty create-time.
    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);

    // The persisted `worktree.reserved` event carries null — not '' — for the
    // owner create-time, so it validated against `.min(1).nullable()` and folds
    // to a null-owner reservation.
    const events = await arm.ctx.eventStore.query(WORKTREES_STREAM);
    const reserved = events.filter((e) => e.type === 'worktree.reserved');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].data?.ownerStartedAt).toBeNull();
    expect(reserved[0].data?.ownerStartedAt).not.toBe('');

    // The folded projection agrees: the reserved entry holds ownerStartedAt: null.
    const view = await handleViewWorktrees({}, arm.ctx, {});
    const worktrees = (view.data as { worktrees: WorktreeEntry[] }).worktrees;
    const entry = worktrees.find((w) => w.worktreeId === '/tmp/wlm-h-nullstart');
    expect(entry?.state).toBe('reserved');
    expect(entry?.ownerStartedAt).toBeNull();
  });
});

// ─── fix 4: exclusive-ownership rejections surfaced by the handlers ───────────

describe('exclusive ownership (acquire/release handlers)', () => {
  it('AcquireWorktree_AlreadyReservedByLiveOwner_ReturnsReservedError', async () => {
    const arm = await createArm();
    const args = {
      repoRoot: '/tmp/wlm-h-repo',
      worktreeId: '/tmp/wlm-h-held',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    };
    // Owner 100 claims it under a source where 100 is live.
    const liveSource: ProcessSource = {
      getStartTime: (pid): StartTimeProbe =>
        pid === 100 ? { status: 'present', startedAt: 'boot-100' } : { status: 'absent' },
    };
    const first = await handleAcquireWorktree(args, arm.ctx, {
      gitProbe: EMPTY_PROBE,
      processSource: liveSource,
    });
    expect(first.success).toBe(true);

    // A different owner cannot claim the live-held worktree.
    const second = await handleAcquireWorktree(
      { ...args, ownerPid: 200, ownerStartedAt: 'boot-200' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('WORKTREE_RESERVED');
  });

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

    // A foreign caller (owner 200) cannot release owner 100's live reservation.
    const release = await handleReleaseWorktree(
      { worktreeId: '/tmp/wlm-h-owned', ownerPid: 200, ownerStartedAt: 'boot-200' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );
    expect(release.success).toBe(false);
    expect(release.error?.code).toBe('WORKTREE_OWNED_BY_OTHER');
  });
});

// ─── ps / wait — read-only liveness surface (DR-4), dispatched via handleView ──
//
// Every assertion drives the PUBLIC composite entry (`handleView`), not the
// handler in isolation, so a missing `case 'ps'`/`'wait'` routing arm (or an
// unregistered action) goes red. Deterministic injected seams only — a fake
// process-table source / identity realpath / injected sleep+clock — so there is
// no OS process scan and no real timer.

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

// DR-3 (task 007): `ps` became scope-parameterized (default `scope: 'all'`
// composes the workflows + operations folds). The WLM-6 worktree liveness fold
// these tests characterize is now the `scope: 'worktree'` path — CONSUMED, not
// changed. Every call below passes `scope: 'worktree'` so it exercises the exact
// same kernel behavior, re-pointed at its preserved address.
describe('ps — in-flight liveness read (DR-4)', () => {
  it('HandleView_Ps_ListsInFlightFromInFlightMerges_NoProcessScan', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-ps',
      sourceBranch: 'feat/x',
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    // The process table is a spy; without `probe` it must NEVER be enumerated.
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

  it('HandleView_Ps_Probe_PullsOnDemandAndEmits', async () => {
    const arm = await createArm();
    // released-wt: owner 555 DEAD (absent), not occupied   → worktree.released
    // orphan-wt:   owner 666 DEAD (absent), occupied by 777 → worktree.orphan_detected
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

    // Only PID 777 is alive, cwd inside the orphan worktree; 555/666 are absent
    // (provably dead). selfPid (999999) is not in the table, so its ancestry is
    // just itself and the foreign occupant 777 counts.
    const table: ProcessTableSource = {
      list: () => [{ pid: 777, ppid: 1, cwd: '/wlm/orphan-wt/sub', startTime: 'b777' }],
    };

    const result = await handleView({ action: 'ps', scope: 'worktree', probe: true }, arm.ctx, {
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

    // The on-demand write path landed both terminal events on the stream.
    const events = await arm.ctx.eventStore.query(WORKTREES_STREAM);
    const types = events.map((e) => e.type);
    expect(types).toContain('worktree.released');
    expect(types).toContain('worktree.orphan_detected');
  });

  it('HandleView_Ps_SurfacesInFlightLaunches_ClearedByTerminal', async () => {
    const arm = await createArm();
    // The launcher reserves its top-level worktree, then a child starts.
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

    // ps surfaces the launch straight from events — no process scan.
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

    // After the terminal folds, ps reflects a cleared launch column.
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

  it('HandleView_Ps_Probe_ReconcilesPhantomLaunch', async () => {
    const arm = await createArm();
    // The launcher reserved its worktree and its child CLAIM landed, but the
    // SUPERVISOR was SIGKILL'd / the host died — no catchable teardown ever ran,
    // so no `launch.executed` terminal was written. This is a permanent phantom
    // that `ps` would fold as in-flight forever without the DR-6 reconciler.
    await seedReserved(arm, {
      worktreeId: '/wlm/phantom-launch-wt',
      path: '/wlm/phantom-launch-wt',
      ownerPid: 8881,
      ownerStartedAt: 'boot-8881',
      operationId: 'op-phantom',
    });
    await emitLaunchExecutingStarted(arm.ctx.eventStore, {
      worktreeId: '/wlm/phantom-launch-wt',
      holderPid: 8882, // the now-dead supervisor holder
      holderStartedAt: 'boot-8882',
    });

    // Provably dead: a SUPPORTED but empty table (the holder PID is absent).
    const table: ProcessTableSource = { list: () => [], isSupported: () => true };

    // Before the probe: the phantom is in-flight, NO terminal written.
    const before = (await arm.ctx.eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'launch.executed',
    );
    expect(before).toHaveLength(0);

    const result = await handleView({ action: 'ps', scope: 'worktree', probe: true }, arm.ctx, {
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
    // The reservation reclaim STILL ran (existing behavior intact)...
    expect(data.probe).toBeDefined();
    // ...and the phantom launch was reconciled to a terminal on the SAME pass.
    expect(data.reconcile.reconciled).toContain('/wlm/phantom-launch-wt');

    // Regression (CodeRabbit, PR #1632): the SAME probe response must report the
    // POST-reconcile launch column, not the stale pre-reconcile snapshot — else a
    // just-healed phantom is reported as BOTH in-flight and reconciled in one call.
    expect(data.launchCount).toBe(0);
    expect(data.launches).toHaveLength(0);

    // The heal wrote exactly one `launch.executed` — the reconciler is the ONLY
    // writer of it here (probeAndReclaim writes worktree.released/orphan_detected).
    const after = (await arm.ctx.eventStore.query(WORKTREES_STREAM)).filter(
      (e) => e.type === 'launch.executed',
    );
    expect(after).toHaveLength(1);
    expect(after[0].data?.worktreeId).toBe('/wlm/phantom-launch-wt');

    // A follow-up ps shows the launch column cleared — no permanent phantom.
    const cleared = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, { realpath: (p) => p });
    expect((cleared.data as { launchCount: number }).launchCount).toBe(0);
  });
});

describe('wait — caller-bounded merge-terminal poll (DR-4)', () => {
  it('HandleView_Wait_AlreadyTerminal_ResolvesImmediately', async () => {
    const arm = await createArm();
    // No holder seeded → the slot is already terminal: resolve on the first fold.
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

  it('HandleView_Wait_InFlightThenTerminal_ResolvesWithinTimeout', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-wait',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    // The injected sleep clears the slot on its first call, so the next re-fold
    // resolves — within the bounded budget, using NO real timer.
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

  it('HandleView_Wait_Timeout_ReturnsStructuredTimeoutNotHang', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-stuck',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    // Controllable clock: each (instant) sleep advances it past the deadline so
    // the bounded poll terminates with a STRUCTURED timeout, never hanging.
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

    // The bounded poll uses the INJECTED sleep seam (which clears the slot on the
    // first poll), so neither a real setTimeout nor a background setInterval is
    // ever created during the manager wait op.
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

// ─── ps / wait — the prune liveness pair (DR-3, task-021) ─────────────────────
//
// task-011 folded the `prune.executing_started` / `prune.executed` INV-10 pair
// into the `worktrees@v1` `inFlightPrunes` projection field but deliberately left
// the READ surface here. These tests pin that surface: `ps` lists the in-flight
// prune column, and `wait until:'idle'` blocks until the prune terminal clears it
// (structured timeout, never a hang). Every assertion drives the PUBLIC composite
// entry (`handleView`) so a missing routing/schema arm goes red.

describe('ps — in-flight prune surface (DR-3)', () => {
  it('PruneWorktrees_InFlight_VisibleViaPs', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-prune',
      repoRoot: '/wlm/repo',
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    // Without `probe` the prune column is a pure fold — the process table (a spy)
    // must NEVER be enumerated.
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

    // After the paired terminal folds, ps reports a cleared prune column — the
    // pair can never surface as a permanent phantom.
    await seedPruneExecuted(arm, { operationId: 'op-prune', deletedCount: 0 });
    const cleared = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx, { realpath: (p) => p });
    const clearedData = cleared.data as { prunes: InFlightPrune[]; pruneCount: number };
    expect(clearedData.pruneCount).toBe(0);
    expect(clearedData.prunes).toEqual([]);
  });
});

describe("wait — until: 'idle' prune-idle poll (DR-3)", () => {
  it('Wait_UntilIdle_ResolvesOnPruneTerminal', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-idle',
      repoRoot: '/wlm/repo',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    // The injected sleep folds the prune terminal on its first call, so the next
    // re-fold sees an empty inFlightPrunes and resolves idle — within the bounded
    // budget, using NO real timer.
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

  it('Wait_UntilIdle_Timeout_StructuredNotHang', async () => {
    const arm = await createArm();
    // A prune pass that never terminates → prune-idle can never be reached.
    await seedPruneStarted(arm, {
      operationId: 'op-stuck-prune',
      repoRoot: '/wlm/repo',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    // Controllable clock: each (instant) sleep advances it past the deadline so
    // the bounded poll terminates with a STRUCTURED timeout, never hanging.
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
  it('WaitSchema_UntilIdleFlag_ParityCliMcp', async () => {
    // 1. Schema-level: `until` auto-emits as an enum flag from the ONE registry
    // schema BOTH facades derive from (addFlagsFromSchema for the CLI, MCP
    // registration for the server) — the structural root of CLI≡MCP parity
    // (INV-2). Pin the exact enum value set + optionality so a schema drift that
    // would desync the two surfaces is caught here.
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

    // 2. Behavioral: drive `wait until:'idle'` through BOTH facades against a
    // prune-idle store. A missing routing/schema/coercion arm on EITHER surface
    // goes red. Empty inFlightPrunes ⇒ resolves on the first fold (no real
    // timer), so both facades run their real OS-backed deps deterministically.
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
