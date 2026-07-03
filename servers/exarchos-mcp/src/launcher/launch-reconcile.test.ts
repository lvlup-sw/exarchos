// ─── Phantom-launch reconciler tests (DR-6) ──────────────────────────────────
//
// Drive `reconcileLaunches` over a REAL EventStore (no git spawn, no OS process
// probe — the process table is a fake in-memory source) and assert against the
// persisted `worktrees` stream + its `worktrees@v1` fold, so the contract is
// pinned at the event-log level the reducer / `ps` read from.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import {
  emitLaunchExecutingStarted,
  LAUNCH_EXECUTED,
} from './liveness.js';
import type {
  ProcessRecord,
  ProcessTableSource,
} from '../orchestrate/worktree/pure/probe.js';
import { reconcileLaunches } from './launch-reconcile.js';

const stateDirs: string[] = [];

async function createStore(): Promise<EventStore> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-launch-reconcile-'));
  stateDirs.push(stateDir);
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return eventStore;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (stateDirs.length > 0) {
    const dir = stateDirs.pop();
    if (dir) await rmrfAsync(dir);
  }
});

/**
 * A fixed-snapshot, SUPPORTED process-table source — `list()` is authoritative,
 * so a PID absent from it is provably gone (mirrors the off-Linux-safe default's
 * Linux path). No `isSupported` predicate → read as supported.
 */
function tableSource(records: readonly ProcessRecord[]): ProcessTableSource {
  return { list: () => records };
}

/**
 * Seed an in-flight launch on the `worktrees` stream: adopt the (task-less,
 * top-level) launcher worktree so the entry EXISTS, then emit the launcher CLAIM
 * (`launch.executing_started`) carrying the supervisor holder identity. This is
 * the exact ordering the real launcher uses (`create-worktree.ts` reserves/adopts
 * before the CLAIM), and the reducer's `markLaunchInFlight` requires the entry to
 * exist first.
 */
async function seedInFlightLaunch(
  eventStore: EventStore,
  input: { worktreeId: string; holderPid: number; holderStartedAt: string },
): Promise<void> {
  await eventStore.append(
    WORKTREES_STREAM,
    {
      type: 'worktree.adopted',
      data: {
        worktreeId: input.worktreeId,
        path: input.worktreeId,
        featureId: null,
        ownerPid: null,
        ownerStartedAt: null,
        operationId: `adopt:${input.worktreeId}`,
      },
    },
    { idempotencyKey: `worktree.adopted:${input.worktreeId}` },
  );
  await emitLaunchExecutingStarted(eventStore, {
    worktreeId: input.worktreeId,
    holderPid: input.holderPid,
    holderStartedAt: input.holderStartedAt,
  });
}

/** Count persisted `launch.executed` terminals for `worktreeId`. */
async function terminalCount(
  eventStore: EventStore,
  worktreeId: string,
): Promise<number> {
  const events = await eventStore.query(WORKTREES_STREAM);
  return events.filter(
    (e) => e.type === LAUNCH_EXECUTED && e.data?.worktreeId === worktreeId,
  ).length;
}

const WT_ID = '/srv/wt/launch-a';

describe('phantom-launch reconciler (DR-6)', () => {
  it('Reconcile_DeadHolderStartedNoExecuted_EmitsTerminal', async () => {
    const eventStore = await createStore();
    // A launch started with supervisor PID 4242, then that supervisor was
    // SIGKILL'd — no terminal was ever written, so the launch is a phantom.
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    // The supervisor PID is ABSENT from a supported table → provably dead.
    const result = await reconcileLaunches(eventStore, tableSource([]));

    // The dead-holder phantom was reconciled to a terminal.
    expect(result.reconciled).toEqual([WT_ID]);
    expect(result.leftInFlight).toEqual([]);
    expect(result.probed).toBe(1);

    // Exactly one `launch.executed` was persisted for the launch (the terminal
    // that clears the reducer's in-flight marker).
    expect(await terminalCount(eventStore, WT_ID)).toBe(1);

    // A re-probe is idempotent: the launch is no longer in-flight, so nothing is
    // reconciled and no second terminal is written.
    const again = await reconcileLaunches(eventStore, tableSource([]));
    expect(again.reconciled).toEqual([]);
    expect(again.probed).toBe(0);
    expect(await terminalCount(eventStore, WT_ID)).toBe(1);
  });

  it('Reconcile_LiveHolder_LeftInFlight', async () => {
    const eventStore = await createStore();
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    // The supervisor PID is PRESENT with a matching create-time → provably alive.
    const liveTable = tableSource([
      { pid: 4242, ppid: 1, cwd: '/', startTime: 'boot-4242' },
    ]);
    const result = await reconcileLaunches(eventStore, liveTable);

    // A live holder is LEFT in-flight — never reconciled away.
    expect(result.reconciled).toEqual([]);
    expect(result.leftInFlight).toEqual([WT_ID]);
    expect(result.probed).toBe(1);

    // NO terminal was written — the launch is still legitimately in flight.
    expect(await terminalCount(eventStore, WT_ID)).toBe(0);
  });

  it('Reconcile_OnDemandOnly_NoPolling', async () => {
    const eventStore = await createStore();
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const beforeInterval = setIntervalSpy.mock.calls.length;
    const beforeTimeout = setTimeoutSpy.mock.calls.length;

    // A full reconcile pass (fold + process-table probe + terminal emit) runs to
    // completion synchronously-driven — no background loop is scheduled.
    const result = await reconcileLaunches(eventStore, tableSource([]));
    expect(result.reconciled).toEqual([WT_ID]);

    // Reconciliation is on-demand ONLY: it registers neither a polling interval
    // nor a deferred timer. (`setInterval` is the polling primitive a background
    // reconciler would use; a clean append path schedules no `setTimeout`.)
    expect(setIntervalSpy.mock.calls.length - beforeInterval).toBe(0);
    expect(setTimeoutSpy.mock.calls.length - beforeTimeout).toBe(0);
  });
});
