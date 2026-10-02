// Tests for `WorktreeManager` reserve, release, and reconcile over a real EventStore, with no mock of the store.
// Reserve and release append one event to the singleton `worktrees` stream through a `decide` over `worktrees@v1`.
// Reconcile releases each reservation whose owner is provably dead, once, and never touches a live owner.
// A repeated reconcile is idempotent, and two concurrent reconciles do not release twice.
// Ownership lives only in events, with no lock file and no JSON side file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource, StartTimeProbe } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';

/** A ProcessSource backed by a PID→create-time map (absent PID ⇒ exited). */
function sourceFrom(table: Record<number, string>): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      return Object.prototype.hasOwnProperty.call(table, pid)
        ? { status: 'present', startedAt: table[pid] }
        : { status: 'absent' };
    },
  };
}

/** A source under which EVERY pid is dead. */
const ALL_DEAD: ProcessSource = sourceFrom({});

/** Read the raw persisted events on the `worktrees` stream. */
function worktreeEvents(store: EventStore) {
  const backend = store.getReadBackend();
  return backend.queryEvents(WORKTREES_STREAM);
}

function eventsOfType(store: EventStore, type: string) {
  return worktreeEvents(store).filter((e) => e.type === type);
}

/** Fold the `worktrees` stream through `worktrees@v1` (state from events alone). */
async function projection(store: EventStore): Promise<WorktreesProjection> {
  const { aggregate } = await store
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

/** Recursively collect every file path under `dir`. */
async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('WorktreeManager (real event store)', () => {
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-manager-'));
    store = new EventStore(stateDir);
    await store.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Reserve goes through a `decide` over `worktrees@v1`, so the idempotency key is `<streamId>:<reducerId>:<operationId>`.
   * The key uses the `operationId` from the payload.
   */
  it('Reserve_AppendsToWorktreesStream_WithOperationIdKey', async () => {
    const manager = new WorktreeManager({ eventStore: store });
    await manager.reserve({
      worktreeId: '/wt/alpha',
      path: '/wt/alpha',
      featureId: 'feat-1',
      ownerPid: 1234,
      ownerStartedAt: 'boot-1234',
    });

    const reserved = eventsOfType(store, 'worktree.reserved');
    expect(reserved).toHaveLength(1);

    const event = reserved[0];
    expect(event.streamId).toBe(WORKTREES_STREAM);
    const operationId = (event.data as { operationId?: unknown }).operationId;
    expect(typeof operationId).toBe('string');
    expect(event.idempotencyKey).toBe(
      `${WORKTREES_STREAM}:${WORKTREES_REDUCER}:${operationId}`,
    );
    expect(event.data).toMatchObject({
      worktreeId: '/wt/alpha',
      path: '/wt/alpha',
      featureId: 'feat-1',
      ownerPid: 1234,
      ownerStartedAt: 'boot-1234',
    });
  });

  /**
   * Two live owners reserve the same worktree at once. Reserve folds `worktrees@v1` under OCC before it appends, so one wins.
   * The loser folds the new state again and gets the holder as its conflict. A blind append lets both succeed.
   */
  it('Reserve_ConcurrentDifferentOwners_OneWins_NoDoubleReserve', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 100: 'boot-100', 200: 'boot-200' }),
    });
    const base = {
      worktreeId: '/wt/contended',
      path: '/wt/contended',
      featureId: 'feat-x',
    };

    const [a, b] = await Promise.all([
      manager.reserve({ ...base, ownerPid: 100, ownerStartedAt: 'boot-100' }),
      manager.reserve({ ...base, ownerPid: 200, ownerStartedAt: 'boot-200' }),
    ]);

    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(1);
    expect([a.reserved, b.reserved].sort()).toEqual([false, true]);
    const loser = a.reserved ? b : a;
    const winner = a.reserved ? a : b;
    expect(winner.conflict).toBeUndefined();
    expect(loser.conflict).toBeDefined();

    const proj = await projection(store);
    const entry = proj.worktrees['/wt/contended'];
    expect(entry.state).toBe('reserved');
    expect([100, 200]).toContain(entry.ownerPid);
    expect(loser.conflict?.ownerPid).toBe(entry.ownerPid);
  });

  /** Owner 100 is live, so a claim by another process is rejected with owner 100 as the conflict. */
  it('Reserve_AlreadyReservedByLiveOwner_RejectsSecondClaim', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 100: 'boot-100' }),
    });
    await manager.reserve({
      worktreeId: '/wt/held',
      path: '/wt/held',
      featureId: 'feat-x',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });

    const second = await manager.reserve({
      worktreeId: '/wt/held',
      path: '/wt/held',
      featureId: 'feat-x',
      ownerPid: 999,
      ownerStartedAt: 'boot-999',
    });
    expect(second.reserved).toBe(false);
    expect(second.conflict).toEqual({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(1);
  });

  /** Owner 100 is live, so owner 200 cannot release the reservation. Owner 100 can release it. */
  it('Release_ForeignLiveOwner_Rejected_LeavesReservationIntact', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 100: 'boot-100' }),
    });
    await manager.reserve({
      worktreeId: '/wt/owned',
      path: '/wt/owned',
      featureId: 'feat-x',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });

    const foreign = await manager.release('/wt/owned', {
      ownerPid: 200,
      ownerStartedAt: 'boot-200',
    });
    expect(foreign.rejectedForeignOwner).toBe(true);
    expect(foreign.released).toBe(false);
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(0);

    let proj = await projection(store);
    expect(proj.worktrees['/wt/owned'].state).toBe('reserved');
    expect(proj.worktrees['/wt/owned'].ownerPid).toBe(100);

    const own = await manager.release('/wt/owned', {
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });
    expect(own.rejectedForeignOwner).toBe(false);
    expect(own.released).toBe(true);
    proj = await projection(store);
    expect(proj.worktrees['/wt/owned'].state).toBe('released');
  });

  it('Reconcile_DeadOwner_EmitsReleasedExactlyOnce', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: ALL_DEAD,
    });
    await manager.reserve({
      worktreeId: '/wt/dead',
      path: '/wt/dead',
      featureId: 'feat-dead',
      ownerPid: 9001,
      ownerStartedAt: 'boot-9001',
    });

    const result = await manager.reconcile();

    expect(result.released).toEqual(['/wt/dead']);
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(1);

    const proj = await projection(store);
    expect(proj.worktrees['/wt/dead'].state).toBe('released');
    expect(proj.worktrees['/wt/dead'].ownerPid).toBeNull();
  });

  /** PID 4242 is live with the create time that the reservation recorded. */
  it('Reconcile_LiveOwnerPidAndStartedAtMatch_NeverReleases', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 4242: 'boot-4242' }),
    });
    await manager.reserve({
      worktreeId: '/wt/live',
      path: '/wt/live',
      featureId: 'feat-live',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });

    const result = await manager.reconcile();

    expect(result.released).toEqual([]);
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(0);

    const proj = await projection(store);
    expect(proj.worktrees['/wt/live'].state).toBe('reserved');
    expect(proj.worktrees['/wt/live'].ownerPid).toBe(4242);
  });

  it('Reconcile_RepeatedRun_IsIdempotent', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: ALL_DEAD,
    });
    await manager.reserve({
      worktreeId: '/wt/once',
      path: '/wt/once',
      featureId: null,
      ownerPid: 7,
      ownerStartedAt: 'boot-7',
    });

    const first = await manager.reconcile();
    const eventCountAfterFirst = worktreeEvents(store).length;

    const second = await manager.reconcile();
    const eventCountAfterSecond = worktreeEvents(store).length;

    expect(first.released).toEqual(['/wt/once']);
    expect(second.released).toEqual([]);
    expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(1);
  });

  it('Reservation_LeavesNoAdvisoryLockFile', async () => {
    const manager = new WorktreeManager({ eventStore: store });
    await manager.reserve({
      worktreeId: '/wt/lockless',
      path: '/wt/lockless',
      featureId: 'feat-1',
      ownerPid: 11,
      ownerStartedAt: 'boot-11',
    });

    const files = await walkFiles(stateDir);
    const lockFiles = files.filter((f) => /\.lock$/i.test(f));
    expect(lockFiles).toEqual([]);
  });

  /** No JSON file exists under the state dir, and the projection rebuilds the state from the event log. */
  it('ReserveRelease_WritesNoJsonSideFile', async () => {
    const manager = new WorktreeManager({ eventStore: store });
    await manager.reserve({
      worktreeId: '/wt/json',
      path: '/wt/json',
      featureId: 'feat-json',
      ownerPid: 22,
      ownerStartedAt: 'boot-22',
    });
    await manager.release('/wt/json');

    const files = await walkFiles(stateDir);
    const jsonFiles = files.filter((f) => /\.json$/i.test(f));
    expect(jsonFiles).toEqual([]);

    const proj = await projection(store);
    expect(proj.worktrees['/wt/json'].state).toBe('released');
    expect(proj.worktrees['/wt/json'].featureId).toBe('feat-json');
  });

  /** Two reconciles race on the same dead reservation. One appends `worktree.released`, and the other folds to a no-op. */
  it('Reconcile_ConcurrentSameWorktree_StreamLockSerializes_NoDoubleRelease', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: ALL_DEAD,
    });
    await manager.reserve({
      worktreeId: '/wt/race',
      path: '/wt/race',
      featureId: 'feat-race',
      ownerPid: 555,
      ownerStartedAt: 'boot-555',
    });

    const [a, b] = await Promise.all([
      manager.reconcile(),
      manager.reconcile(),
    ]);

    expect(eventsOfType(store, 'worktree.released')).toHaveLength(1);
    const releasedReports = [...a.released, ...b.released];
    expect(releasedReports).toEqual(['/wt/race']);

    const proj = await projection(store);
    expect(proj.worktrees['/wt/race'].state).toBe('released');
  });
});
