/**
 * `worktrees@v1` projection reducer + self-registration tests (WLM foundation).
 *
 * Covers the DR-1 fold contract (state reproduced from the log alone, immutable
 * apply, cold-rebuild equivalence), the WorktreeEntry field carry-through, the
 * remove-executed drop (with symlink-resolved correlation), and the
 * central-barrel registration guard via `aggregateStream`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  createWorktreesReducer,
  worktreesReducer,
  type WorktreesProjection,
} from './worktrees.js';
import type { WorkflowEvent } from '../../../event-store/schemas.js';
import type { RealpathResolver } from '../pure/path-containment.js';
import { toPosix } from '../../../utils/paths.js';
import { assertReducerImmutable } from '../../../projections/testing.js';

// Side-effect import — registers `worktrees@v1` with the process-wide
// `defaultRegistry` THROUGH the central projections barrel. The guard test
// below resolves the id via that registry; if the side-effect import line in
// `src/projections/index.ts` is removed, resolution throws and the guard fails.
import '../../../projections/index.js';
import { EventStore } from '../../../event-store/store.js';
import { AtomicAppender } from '../../../event-store/atomic-appender.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Build a `WorkflowEvent` shape with sane defaults for fields the reducer does
 * not consume. Mirrors the sibling taskstore test's `buildEvent`.
 */
function buildEvent(overrides: {
  type: string;
  sequence?: number;
  data?: Record<string, unknown>;
}): WorkflowEvent {
  return {
    streamId: 'worktrees',
    sequence: overrides.sequence ?? 1,
    timestamp: '2026-06-25T00:00:00.000Z',
    type: overrides.type,
    schemaVersion: '1.0',
    data: overrides.data,
  } as WorkflowEvent;
}

/** Identity resolver — `path.resolve` already normalised the input. */
const identityRealpath: RealpathResolver = (p) => p;

// Canonical worktree ids used across the suite, in the SAME separator-stable
// form production keys under: `toPosix(path.resolve(...))` (#1620). The reducer
// canonicalizes a remove event's `worktreePath` to this exact form, so the keys
// must match it on Windows (forward-slash) as well as POSIX (no-op there).
const WT_A = toPosix(path.resolve('/srv/wt/feature-a'));
const WT_B = toPosix(path.resolve('/srv/wt/feature-b'));

describe('worktreesReducer.apply (WLM foundation)', () => {
  it('WorktreesReducer_FoldEvents_ReproducesStateFromLogAlone', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const log: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.reserved',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: 4242,
          ownerStartedAt: '2026-06-25T01:00:00.000Z',
          operationId: 'op-2',
        },
      }),
      buildEvent({
        type: 'worktree.adopted',
        sequence: 3,
        data: { worktreeId: WT_B, path: WT_B, featureId: null, operationId: 'op-3' },
      }),
    ];

    const state = log.reduce(
      (acc, ev) => reducer.apply(acc, ev),
      reducer.initial,
    );

    // State is fully determined by the log — nothing read from the environment.
    expect(state).toEqual({
      projectionSequence: 3,
      worktrees: {
        [WT_A]: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          state: 'reserved',
          ownerPid: 4242,
          ownerStartedAt: '2026-06-25T01:00:00.000Z',
        },
        [WT_B]: {
          worktreeId: WT_B,
          path: WT_B,
          featureId: null,
          state: 'adopted',
          ownerPid: null,
          ownerStartedAt: null,
        },
      },
    } satisfies WorktreesProjection);
  });

  it('WorktreesReducer_AnyEventOrder_PassesAssertReducerImmutable', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const events: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.reserved',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: 7,
          ownerStartedAt: '2026-06-25T01:00:00.000Z',
          operationId: 'op-2',
        },
      }),
      buildEvent({
        type: 'worktree.released',
        sequence: 3,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-3' },
      }),
      buildEvent({
        type: 'worktree.orphan_detected',
        sequence: 4,
        data: { worktreeId: WT_B, path: WT_B, featureId: null, operationId: 'op-4' },
      }),
      buildEvent({
        type: 'worktree.remove.requested',
        sequence: 5,
        data: { worktreePath: WT_B, operationId: 'op-5' },
      }),
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 6,
        data: { worktreePath: WT_B, removed: true, operationId: 'op-5' },
      }),
    ];

    // Deep-freezes the seed + every intermediate; any in-place mutation of the
    // `state` argument throws a TypeError under ESM strict mode.
    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
    // And a reversed order must also stay immutable (order independence of the
    // purity property).
    expect(() =>
      assertReducerImmutable(reducer, [...events].reverse()),
    ).not.toThrow();
  });

  it('WorktreesReducer_ColdRebuild_EqualsLiveState', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const log: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.reserved',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: 99,
          ownerStartedAt: '2026-06-25T02:00:00.000Z',
          operationId: 'op-2',
        },
      }),
      buildEvent({
        type: 'worktree.adopted',
        sequence: 3,
        data: { worktreeId: WT_B, path: WT_B, featureId: 'feat-b', operationId: 'op-3' },
      }),
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 4,
        data: { worktreePath: WT_B, removed: true, operationId: 'op-4' },
      }),
    ];

    // "Live" — fold each event as it arrives, threading the accumulator.
    let live = reducer.initial;
    for (const ev of log) {
      live = reducer.apply(live, ev);
    }

    // "Cold rebuild" — replay the same persisted log from the seed.
    const cold = log.reduce(
      (acc, ev) => reducer.apply(acc, ev),
      reducer.initial,
    );

    expect(cold).toEqual(live);
    // WT_B was adopted then removed → absent (no `removed` state).
    expect(Object.keys(cold.worktrees)).toEqual([WT_A]);
  });

  it('WorktreesReducer_EntryCarriesFeatureIdAndOwnerFields', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const adopted = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
    );
    // Adopted: featureId carried; owner fields null (no live reservation).
    expect(adopted.worktrees[WT_A]).toEqual({
      worktreeId: WT_A,
      path: WT_A,
      featureId: 'feat-a',
      state: 'adopted',
      ownerPid: null,
      ownerStartedAt: null,
    });

    const reserved = reducer.apply(
      adopted,
      buildEvent({
        type: 'worktree.reserved',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: 31337,
          ownerStartedAt: '2026-06-25T03:00:00.000Z',
          operationId: 'op-2',
        },
      }),
    );
    // Reserved: owner fields populated from the event.
    expect(reserved.worktrees[WT_A]).toMatchObject({
      featureId: 'feat-a',
      state: 'reserved',
      ownerPid: 31337,
      ownerStartedAt: '2026-06-25T03:00:00.000Z',
    });

    const released = reducer.apply(
      reserved,
      buildEvent({
        type: 'worktree.released',
        sequence: 3,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-3' },
      }),
    );
    // Released: owner cleared, featureId retained (non-null only while reserved).
    expect(released.worktrees[WT_A]).toEqual({
      worktreeId: WT_A,
      path: WT_A,
      featureId: 'feat-a',
      state: 'released',
      ownerPid: null,
      ownerStartedAt: null,
    });
  });

  it('WorktreesReducer_RemoveExecuted_DropsEntryFromProjection', () => {
    // ── Case 1: non-symlinked path, identity resolver ──
    const reducer = createWorktreesReducer(identityRealpath);
    const adopted = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
    );
    expect(adopted.worktrees[WT_A]).toBeDefined();

    const removed = reducer.apply(
      adopted,
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 2,
        // remove pair carries `worktreePath`, not `worktreeId`.
        data: { worktreePath: WT_A, removed: true, operationId: 'op-1' },
      }),
    );
    // Entry dropped — absence is terminal (there is no `removed` state).
    expect(WT_A in removed.worktrees).toBe(false);
    expect(removed.projectionSequence).toBe(2);

    // Idempotent: a remove for an already-absent worktree is a no-op (identity).
    const removedAgain = reducer.apply(
      removed,
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 3,
        data: { worktreePath: WT_A, removed: false, operationId: 'op-1' },
      }),
    );
    expect(removedAgain).toBe(removed);

    // ── Case 2: symlinked path — worktreeId is the symlink-resolved form,
    // the remove event carries the unresolved path; the injected resolver
    // canonicalizes it back to the stored worktreeId. ──
    const rawSymlink = path.resolve('/var/wt/feature-c');
    // The resolver returns the OS-native symlink target; the stored key is its
    // `toPosix` form (what production keys under), and the reducer canonicalizes
    // the remove event's `worktreePath` to the same form (#1620).
    const osCanonical = path.resolve('/private/var/wt/feature-c');
    const canonical = toPosix(osCanonical);
    const symlinkRealpath: RealpathResolver = (p) =>
      p === rawSymlink ? osCanonical : p;
    const symReducer = createWorktreesReducer(symlinkRealpath);

    const symAdopted = symReducer.apply(
      symReducer.initial,
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        // worktreeId IS the canonical (symlink-resolved) path.
        data: { worktreeId: canonical, path: rawSymlink, featureId: 'feat-c', operationId: 'op-c' },
      }),
    );
    expect(symAdopted.worktrees[canonical]).toBeDefined();

    const symRemoved = symReducer.apply(
      symAdopted,
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 2,
        // unresolved path — resolver maps it back to `canonical`.
        data: { worktreePath: rawSymlink, removed: true, operationId: 'op-c' },
      }),
    );
    expect(canonical in symRemoved.worktrees).toBe(false);
  });
});

describe('worktrees@v1 registration guard (DR-1)', () => {
  it('Projection_WorktreesV1_IsRegistered_AggregateStreamResolves', async () => {
    // Resolving `worktrees@v1` through the process-wide registry (populated by
    // the central projections barrel imported at the top of this file) must NOT
    // throw `UnknownProjectionIdError`. `aggregateStream` is the per-stream
    // resolution seam; on an empty `worktrees` stream it returns the reducer's
    // initial state at version 0.
    const stateDir = await mkdtemp(path.join(tmpdir(), 'worktrees-reg-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const appender = eventStore.getAppender() as AtomicAppender;
    try {
      const result = await appender.aggregateStream<WorktreesProjection>(
        'worktrees',
        'worktrees@v1',
      );
      expect(result.version).toBe(0);
      expect(result.aggregate).toEqual(worktreesReducer.initial);
    } finally {
      await rmrfAsync(stateDir);
    }
  });
});
