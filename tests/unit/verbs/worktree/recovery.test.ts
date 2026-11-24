/**
 * Recovery tests for the crash paths of the liveness and merge surface.
 * A crashed merge of an old log leaves an unpaired `worktree.merge_requested`.
 * When its holder is provably dead, the `reconcileMerges` pass in `reconcile_worktrees` frees the slot with exactly one terminal event.
 * The reservation reclaim of the manager fails closed on an unsupported process table, and one failed append does not stop the pass.
 * The tests use a real SQLite EventStore, because its stream-version check inside the transaction is the cross-process guard.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

import { handleReconcileWorktrees } from '../../../../src/verbs/worktree/handlers.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from '../../../../src/verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';
import type { ProcessTableSource, ProcessRecord } from '../../../../src/verbs/worktree/pure/probe.js';

interface Arm {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly ctx: DispatchContext;
}

const arms: Arm[] = [];

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

describe('DR-3 — crash-mid-merge reconciled from the reconcile_worktrees production entry', () => {
  /**
   * Holder 4242 is absent from the supported table.
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
