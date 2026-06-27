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

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { handleView } from '../../views/composite.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
} from './handlers.js';
import { WORKTREES_STREAM, type GitWorktreeProbe } from './manager.js';
import type { ProcessSource, StartTimeProbe } from './pure/process-identity.js';
import type { ProcessTableSource, ProcessRecord } from './pure/probe.js';
import type { InFlightMerge } from './projections/worktrees.js';

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

    const result = await handleView({ action: 'ps' }, arm.ctx, {
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

    const result = await handleView({ action: 'ps', probe: true }, arm.ctx, {
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
