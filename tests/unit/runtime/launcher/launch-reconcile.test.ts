/**
 * Tests for the phantom-launch reconciler.
 *
 * Each test runs `reconcileLaunches` on a real `EventStore` with an in-memory process table.
 * The assertions read the result of the pass and the persisted `worktrees` stream.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import {
  emitLaunchExecutingStarted,
  LAUNCH_EXECUTED,
} from '../../../../src/runtime/launcher/liveness.js';
import type {
  ProcessRecord,
  ProcessTableSource,
} from '../../../../src/verbs/worktree/pure/probe.js';
import { reconcileLaunches } from '../../../../src/runtime/launcher/launch-reconcile.js';

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
 * A process table with a fixed snapshot. It has no `isSupported` predicate, so it reads as supported.
 * Thus an absent PID is provably dead.
 */
function tableSource(records: readonly ProcessRecord[]): ProcessTableSource {
  return { list: () => records };
}

/**
 * Seeds an in-flight launch: adopts the launcher worktree, then emits `launch.executing_started`.
 * The reducer attaches the in-flight marker only to an entry that exists.
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
  /**
   * The supervisor PID is absent from the process table, so the pass writes one terminal.
   * A second pass finds no launch in flight and writes no second terminal.
   */
  it('Reconcile_DeadHolderStartedNoExecuted_EmitsTerminal', async () => {
    const eventStore = await createStore();
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    const result = await reconcileLaunches(eventStore, tableSource([]));

    expect(result.reconciled).toEqual([WT_ID]);
    expect(result.leftInFlight).toEqual([]);
    expect(result.probed).toBe(1);

    expect(await terminalCount(eventStore, WT_ID)).toBe(1);

    const again = await reconcileLaunches(eventStore, tableSource([]));
    expect(again.reconciled).toEqual([]);
    expect(again.probed).toBe(0);
    expect(await terminalCount(eventStore, WT_ID)).toBe(1);
  });

  /**
   * Two launches have dead holders, and the terminal append for one of them rejects.
   * The pass does not reject. It reconciles the other launch and leaves the failed one in flight.
   */
  it('Reconcile_OneTerminalAppendFails_OthersStillReconciled', async () => {
    const eventStore = await createStore();
    const WT_FAIL = '/srv/wt/launch-fail';
    const WT_OK = '/srv/wt/launch-ok';
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_FAIL,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_OK,
      holderPid: 4343,
      holderStartedAt: 'boot-4343',
    });

    const realAppend = eventStore.append.bind(eventStore);
    vi.spyOn(eventStore, 'append').mockImplementation(
      (...args: Parameters<EventStore['append']>) => {
        const [, event] = args;
        const worktreeId = (event.data as Record<string, unknown> | undefined)?.worktreeId;
        if (event.type === LAUNCH_EXECUTED && worktreeId === WT_FAIL) {
          return Promise.reject(new Error('append boom for WT_FAIL'));
        }
        return realAppend(...args);
      },
    );

    const result = await reconcileLaunches(eventStore, tableSource([]));

    expect(result.probed).toBe(2);
    expect(result.reconciled).toEqual([WT_OK]);
    expect(result.leftInFlight).toEqual([WT_FAIL]);
    expect(await terminalCount(eventStore, WT_OK)).toBe(1);
    expect(await terminalCount(eventStore, WT_FAIL)).toBe(0);
  });

  /** The holder PID is in the process table with a matching start time, so the pass writes no terminal. */
  it('Reconcile_LiveHolder_LeftInFlight', async () => {
    const eventStore = await createStore();
    await seedInFlightLaunch(eventStore, {
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    const liveTable = tableSource([
      { pid: 4242, ppid: 1, cwd: '/', startTime: 'boot-4242' },
    ]);
    const result = await reconcileLaunches(eventStore, liveTable);

    expect(result.reconciled).toEqual([]);
    expect(result.leftInFlight).toEqual([WT_ID]);
    expect(result.probed).toBe(1);

    expect(await terminalCount(eventStore, WT_ID)).toBe(0);
  });

  /** A full pass that writes a terminal calls neither `setInterval` nor `setTimeout`. */
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

    const result = await reconcileLaunches(eventStore, tableSource([]));
    expect(result.reconciled).toEqual([WT_ID]);

    expect(setIntervalSpy.mock.calls.length - beforeInterval).toBe(0);
    expect(setTimeoutSpy.mock.calls.length - beforeTimeout).toBe(0);
  });
});
