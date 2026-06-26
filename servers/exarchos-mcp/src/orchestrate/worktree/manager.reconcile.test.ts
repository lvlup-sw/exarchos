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

import { EventStore } from '../../event-store/store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from './manager.js';
import type { ProcessSource } from './pure/process-identity.js';
import type { WorktreesProjection } from './projections/worktrees.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A ProcessSource backed by a PID→create-time map (absent PID ⇒ exited). */
function sourceFrom(table: Record<number, string>): ProcessSource {
  return {
    getStartTime(pid: number): string | null {
      return Object.prototype.hasOwnProperty.call(table, pid)
        ? table[pid]
        : null;
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
    // Two-component idempotency key: `<eventType>:<operationId>`.
    const operationId = (event.data as { operationId?: unknown }).operationId;
    expect(typeof operationId).toBe('string');
    expect(event.idempotencyKey).toBe(`worktree.reserved:${operationId}`);
    // Payload round-trips the reservation owner.
    expect(event.data).toMatchObject({
      worktreeId: '/wt/alpha',
      path: '/wt/alpha',
      featureId: 'feat-1',
      ownerPid: 1234,
      ownerStartedAt: 'boot-1234',
    });
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
