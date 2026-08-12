// ─── WorktreeManager — crash-safe reservation + heal-as-reconcile-fold (DR-3) ─
//
// HIGH-tier integration suite: every assertion drives the REAL EventStore /
// SQLite substrate (a per-test tmp `stateDir`), so the reserve / release /
// reconcile contract is pinned across the actual event-store seam — not a mock.
//
// Contract under test:
//   - reserve / release append a single event to the singleton `worktrees`
//     stream keyed by the two-component `<eventType>:<operationId>` idempotency
//     convention.
//   - reconcile releases every reservation whose owner is provably dead, exactly
//     once, never touching a live owner, idempotent on repeat, and serialized so
//     two concurrent reconciles never double-release.
//   - ownership lives ONLY in events: no advisory lock file, no JSON side file —
//     state is rebuildable from the stream alone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from './manager.js';
import type { ProcessSource, StartTimeProbe } from './pure/process-identity.js';
import type { WorktreesProjection } from './projections/worktrees.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Suite ────────────────────────────────────────────────────────────────────

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

  // ─── reserve ────────────────────────────────────────────────────────────────

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
    // Lands on the dedicated singleton `worktrees` stream.
    expect(event.streamId).toBe(WORKTREES_STREAM);
    // reserve now routes through `decide` over worktrees@v1 (fold → validate
    // exclusive ownership → append under OCC), so the per-call idempotency key is
    // the decide-derived `<streamId>:<reducerId>:<operationId>` — one key per call,
    // still anchored on the payload's operationId.
    const operationId = (event.data as { operationId?: unknown }).operationId;
    expect(typeof operationId).toBe('string');
    expect(event.idempotencyKey).toBe(
      `${WORKTREES_STREAM}:${WORKTREES_REDUCER}:${operationId}`,
    );
    // Payload round-trips the reservation owner.
    expect(event.data).toMatchObject({
      worktreeId: '/wt/alpha',
      path: '/wt/alpha',
      featureId: 'feat-1',
      ownerPid: 1234,
      ownerStartedAt: 'boot-1234',
    });
  });

  // ─── reserve: exclusive ownership (fold-before-append, fix 4) ─────────────────

  it('Reserve_ConcurrentDifferentOwners_OneWins_NoDoubleReserve', async () => {
    // Two live owners race to reserve the SAME worktree. Because reserve now
    // folds worktrees@v1 under OCC before appending, exactly ONE wins; the loser
    // re-folds against the now-reserved state and is rejected. A blind append
    // (the bug) would let BOTH "succeed", fabricating two concurrent owners.
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 100: 'boot-100', 200: 'boot-200' }), // both live
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

    // Exactly one `worktree.reserved` was appended.
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(1);
    // Exactly one call reports `reserved: true`; the other is rejected with the
    // winning owner surfaced as the conflict.
    expect([a.reserved, b.reserved].sort()).toEqual([false, true]);
    const loser = a.reserved ? b : a;
    const winner = a.reserved ? a : b;
    expect(winner.conflict).toBeUndefined();
    expect(loser.conflict).toBeDefined();

    // The fold shows a single live owner — whichever won.
    const proj = await projection(store);
    const entry = proj.worktrees['/wt/contended'];
    expect(entry.state).toBe('reserved');
    expect([100, 200]).toContain(entry.ownerPid);
    // The reported conflict owner is the one that actually holds the lease.
    expect(loser.conflict?.ownerPid).toBe(entry.ownerPid);
  });

  it('Reserve_AlreadyReservedByLiveOwner_RejectsSecondClaim', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 100: 'boot-100' }), // owner 100 is live
    });
    await manager.reserve({
      worktreeId: '/wt/held',
      path: '/wt/held',
      featureId: 'feat-x',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });

    // A different process tries to claim the live-owned worktree → rejected.
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

  // ─── release: never free a foreign live owner's claim (fix 4) ─────────────────

  it('Release_ForeignLiveOwner_Rejected_LeavesReservationIntact', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 100: 'boot-100' }), // owner 100 is live
    });
    await manager.reserve({
      worktreeId: '/wt/owned',
      path: '/wt/owned',
      featureId: 'feat-x',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });

    // A stale/foreign caller (owner 200) must NOT be able to release owner 100's
    // live reservation.
    const foreign = await manager.release('/wt/owned', {
      ownerPid: 200,
      ownerStartedAt: 'boot-200',
    });
    expect(foreign.rejectedForeignOwner).toBe(true);
    expect(foreign.released).toBe(false);
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(0);

    // The reservation is intact — still held by owner 100.
    let proj = await projection(store);
    expect(proj.worktrees['/wt/owned'].state).toBe('reserved');
    expect(proj.worktrees['/wt/owned'].ownerPid).toBe(100);

    // The true owner CAN release it.
    const own = await manager.release('/wt/owned', {
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });
    expect(own.rejectedForeignOwner).toBe(false);
    expect(own.released).toBe(true);
    proj = await projection(store);
    expect(proj.worktrees['/wt/owned'].state).toBe('released');
  });

  // ─── reconcile: dead owner ────────────────────────────────────────────────────

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

    // State folds to `released` — owner fields cleared.
    const proj = await projection(store);
    expect(proj.worktrees['/wt/dead'].state).toBe('released');
    expect(proj.worktrees['/wt/dead'].ownerPid).toBeNull();
  });

  // ─── reconcile: live owner ────────────────────────────────────────────────────

  it('Reconcile_LiveOwnerPidAndStartedAtMatch_NeverReleases', async () => {
    const manager = new WorktreeManager({
      eventStore: store,
      // PID 4242 is live with the exact create-time the reservation recorded.
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

  // ─── reconcile: idempotent on repeat ──────────────────────────────────────────

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
    // The second pass appends nothing.
    expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(1);
  });

  // ─── no advisory lock file ────────────────────────────────────────────────────

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

  // ─── no JSON ownership side file ──────────────────────────────────────────────

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

    // No JSON ownership cache anywhere under the state dir.
    const files = await walkFiles(stateDir);
    const jsonFiles = files.filter((f) => /\.json$/i.test(f));
    expect(jsonFiles).toEqual([]);

    // State is fully rebuildable from the event log alone.
    const proj = await projection(store);
    expect(proj.worktrees['/wt/json'].state).toBe('released');
    expect(proj.worktrees['/wt/json'].featureId).toBe('feat-json');
  });

  // ─── concurrent reconcile: stream-lock serialization ──────────────────────────

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

    // Two reconciles racing on the same dead reservation.
    const [a, b] = await Promise.all([
      manager.reconcile(),
      manager.reconcile(),
    ]);

    // At most one `worktree.released` is appended for the dead worktree.
    expect(eventsOfType(store, 'worktree.released')).toHaveLength(1);
    // Exactly one of the two passes reports the release; the other re-folds to
    // a no-op against the now-`released` state.
    const releasedReports = [...a.released, ...b.released];
    expect(releasedReports).toEqual(['/wt/race']);

    const proj = await projection(store);
    expect(proj.worktrees['/wt/race'].state).toBe('released');
  });
});
