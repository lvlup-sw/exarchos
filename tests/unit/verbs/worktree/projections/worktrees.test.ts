/**
 * Tests for the `worktrees@v1` projection reducer and its registration.
 *
 * The fold reproduces state from the log alone, does not change its input, and
 * gives the same result on a cold rebuild. The suite also covers the
 * `WorktreeEntry` fields, the drop on `worktree.remove.executed` with
 * symlink-resolved correlation, and the in-flight merge, launch, and prune folds.
 *
 * The import of `src/projections/index.js` registers `worktrees@v1` with the
 * process-wide `defaultRegistry`. If that barrel stops the registration, the
 * guard test fails.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  createWorktreesReducer,
  worktreesReducer,
  type WorktreesProjection,
} from '../../../../../src/verbs/worktree/projections/worktrees.js';
import type { WorkflowEvent } from '../../../../../src/events/schemas.js';
import type { RealpathResolver } from '../../../../../src/verbs/worktree/pure/path-containment.js';
import { toPosix } from '../../../../../src/utils/paths.js';
import { assertReducerImmutable } from '../../../../../src/projections/testing.js';

import '../../../../../src/projections/index.js';
import { EventStore } from '../../../../../src/events/store.js';
import { AtomicAppender } from '../../../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';

/** Builds a `WorkflowEvent` with defaults for the fields that the reducer does not read. */
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

/** A resolver that returns each path unchanged, because `path.resolve` already normalized the input. */
const identityRealpath: RealpathResolver = (p) => p;

/**
 * A canonical worktree id in the production key form `toPosix(path.resolve(...))`.
 * The reducer converts the `worktreePath` of a remove event to this form, so
 * the key matches on Windows and on POSIX.
 */
const WT_A = toPosix(path.resolve('/srv/wt/feature-a'));
/** A second canonical worktree id in the same form as `WT_A`. */
const WT_B = toPosix(path.resolve('/srv/wt/feature-b'));

/**
 * An integration branch ref, not a filesystem path. `inFlightMerges` keys on
 * `integrationRef`, which usually has no adopted worktree entry, because the
 * integration branch is the main worktree.
 */
const INT_REF = 'feat/wlm-operational-core';
/** A second integration branch ref. */
const INT_REF_OTHER = 'feat/other-integration';

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
      inFlightMerges: {},
      inFlightPrunes: {},
    } satisfies WorktreesProjection);
  });

  /**
   * `assertReducerImmutable` deep-freezes the seed and each intermediate state,
   * so a change in place throws. The check runs in both event orders.
   */
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

    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
    expect(() =>
      assertReducerImmutable(reducer, [...events].reverse()),
    ).not.toThrow();
  });

  /**
   * The live state folds each event in a loop. The cold rebuild replays the
   * same log from the seed. `WT_B` is adopted and then removed, so it is absent.
   */
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

    let live = reducer.initial;
    for (const ev of log) {
      live = reducer.apply(live, ev);
    }

    const cold = log.reduce(
      (acc, ev) => reducer.apply(acc, ev),
      reducer.initial,
    );

    expect(cold).toEqual(live);
    expect(Object.keys(cold.worktrees)).toEqual([WT_A]);
  });

  /**
   * An adopted entry keeps `featureId` and has `null` owner fields. A reserved
   * entry takes the owner fields from the event. A released entry clears the
   * owner fields and keeps `featureId`.
   */
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
    expect(released.worktrees[WT_A]).toEqual({
      worktreeId: WT_A,
      path: WT_A,
      featureId: 'feat-a',
      state: 'released',
      ownerPid: null,
      ownerStartedAt: null,
    });
  });

  /**
   * The remove event carries `worktreePath`, not `worktreeId`. The entry is
   * dropped, because there is no `removed` state, and a second remove returns
   * the same state. In the symlink case, the event carries the unresolved path,
   * and the injected resolver maps it to the stored canonical key.
   */
  it('WorktreesReducer_RemoveExecuted_DropsEntryFromProjection', () => {
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
        data: { worktreePath: WT_A, removed: true, operationId: 'op-1' },
      }),
    );
    expect(WT_A in removed.worktrees).toBe(false);
    expect(removed.projectionSequence).toBe(2);

    const removedAgain = reducer.apply(
      removed,
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 3,
        data: { worktreePath: WT_A, removed: false, operationId: 'op-1' },
      }),
    );
    expect(removedAgain).toBe(removed);

    const rawSymlink = path.resolve('/var/wt/feature-c');
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
        data: { worktreeId: canonical, path: rawSymlink, featureId: 'feat-c', operationId: 'op-c' },
      }),
    );
    expect(symAdopted.worktrees[canonical]).toBeDefined();

    const symRemoved = symReducer.apply(
      symAdopted,
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 2,
        data: { worktreePath: rawSymlink, removed: true, operationId: 'op-c' },
      }),
    );
    expect(canonical in symRemoved.worktrees).toBe(false);
  });

  /**
   * When the remove event carries a canonical `worktreeId`, the reducer drops by
   * that stored key and ignores `worktreePath`. It does not access the
   * filesystem, so a cold rebuild depends on the log alone. The resolver throws,
   * so a realpath call fails the test.
   */
  it('WorktreesReducer_RemoveExecuted_DropsByStoredWorktreeId_NoFilesystemAtFoldTime', () => {
    const throwingRealpath: RealpathResolver = () => {
      throw new Error('realpath must NOT be called when worktreeId is stamped');
    };
    const reducer = createWorktreesReducer(throwingRealpath);

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
        data: {
          worktreePath: '/some/now-deleted/or/foreign/path',
          worktreeId: WT_A,
          removed: true,
          operationId: 'op-1',
        },
      }),
    );

    expect(WT_A in removed.worktrees).toBe(false);
    expect(removed.projectionSequence).toBe(2);
  });

  /**
   * Old remove events carry only `worktreePath`, with no `worktreeId`, and can
   * target a worktree that the log never adopted. The fold must not throw. A
   * `worktree.remove.requested` is a no-op. The realpath fallback maps the old
   * terminal for `WT_A` to its stored key and drops it. The remove for `WT_B`,
   * which was never adopted, is a no-op. So only two events advance the sequence.
   */
  it('WorktreesReducer_PreUnificationHistoryReplay_FoldsWithoutError', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const log: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.remove.requested',
        sequence: 2,
        data: { worktreePath: WT_A, operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 3,
        data: { worktreePath: WT_A, removed: true, operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 4,
        data: { worktreePath: WT_B, removed: false, operationId: 'op-x' },
      }),
    ];

    let state: WorktreesProjection = reducer.initial;
    expect(() => {
      state = log.reduce((acc, ev) => reducer.apply(acc, ev), reducer.initial);
    }).not.toThrow();

    expect(WT_A in state.worktrees).toBe(false);
    expect(WT_B in state.worktrees).toBe(false);
    expect(state.projectionSequence).toBe(2);
  });
});

describe('worktreesReducer.apply — in-flight merges + orphan folding (DR-4)', () => {
  /**
   * A requested merge with no terminal is in `inFlightMerges`, keyed by its
   * `integrationRef`, with the holder fields as they are. It does not appear in
   * the `worktrees` map.
   */
  it('WorktreesProjection_MergeRequestedNoExecuted_AppearsInInFlightMerges', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const state = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 1,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/wlm-oc-003-reducer',
          operationId: 'op-merge-1',
          holderPid: 5151,
          holderStartedAt: '2026-06-25T04:00:00.000Z',
        },
      }),
    );

    expect(state.inFlightMerges[INT_REF]).toEqual({
      integrationRef: INT_REF,
      operationId: 'op-merge-1',
      sourceBranch: 'task/wlm-oc-003-reducer',
      holderPid: 5151,
      holderStartedAt: '2026-06-25T04:00:00.000Z',
      worktreeId: null,
    });
    expect(state.worktrees).toEqual({});
    expect(state.projectionSequence).toBe(1);
  });

  /** The release clears the in-flight entry. A second release for the same merge returns the same state. */
  it('WorktreesProjection_MergeRequestedThenExecuted_ClearsInFlightMerges', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const requested = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 1,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/x',
          operationId: 'op-merge-1',
          holderPid: 6262,
          holderStartedAt: '2026-06-25T05:00:00.000Z',
        },
      }),
    );
    expect(requested.inFlightMerges[INT_REF]).toBeDefined();

    const executed = reducer.apply(
      requested,
      buildEvent({
        type: 'worktree.merge_executed',
        sequence: 2,
        data: {
          integrationRef: INT_REF,
          operationId: 'op-merge-1',
          status: 'merged',
          mergeSha: 'abc1234',
        },
      }),
    );
    expect(INT_REF in executed.inFlightMerges).toBe(false);
    expect(executed.inFlightMerges).toEqual({});
    expect(executed.projectionSequence).toBe(2);

    const executedAgain = reducer.apply(
      executed,
      buildEvent({
        type: 'worktree.merge_executed',
        sequence: 3,
        data: { integrationRef: INT_REF, operationId: 'op-merge-1', status: 'merged' },
      }),
    );
    expect(executedAgain).toBe(executed);
  });

  /**
   * No adopted worktree entry has the key `integrationRef`, because the
   * integration branch is the main worktree. The merge still has an entry in
   * `inFlightMerges`, and the unrelated adopted entry stays the same.
   */
  it('WorktreesProjection_IntegrationMergeWithNoWorktreeEntry_HasHomeInInFlightMerges', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const adopted = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
    );

    const merged = reducer.apply(
      adopted,
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 2,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/x',
          operationId: 'op-merge-1',
          holderPid: 7373,
          holderStartedAt: '2026-06-25T06:00:00.000Z',
        },
      }),
    );

    expect(INT_REF in merged.worktrees).toBe(false);
    expect(merged.inFlightMerges[INT_REF]).toMatchObject({
      integrationRef: INT_REF,
      sourceBranch: 'task/x',
      holderPid: 7373,
      worktreeId: null,
    });
    expect(merged.worktrees[WT_A].state).toBe('adopted');
  });

  /**
   * A stale release with a different `operationId` must not clear the current
   * claim on the same `integrationRef`. The reducer returns the same state, with
   * no sequence bump.
   */
  it('WorktreesProjection_MergeExecuted_MismatchedOperationId_DoesNotClobberClaim', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const requested = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 1,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/current',
          operationId: 'op-current',
          holderPid: 33,
          holderStartedAt: '2026-06-25T10:00:00.000Z',
        },
      }),
    );

    const stale = reducer.apply(
      requested,
      buildEvent({
        type: 'worktree.merge_executed',
        sequence: 2,
        data: { integrationRef: INT_REF, operationId: 'op-stale', status: 'aborted' },
      }),
    );
    expect(stale).toBe(requested);
    expect(stale.inFlightMerges[INT_REF].operationId).toBe('op-current');
  });

  /**
   * A `worktree.merge_executed` with no `operationId` cannot prove that it owns
   * the lease, so it must clear nothing. The reducer returns the same state, with
   * no sequence bump. Then a malformed event cannot clear a live lease.
   */
  it('WorktreesProjection_MergeExecuted_MissingOperationId_DoesNotClearLease', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const requested = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 1,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/current',
          operationId: 'op-current',
          holderPid: 33,
          holderStartedAt: '2026-06-25T10:00:00.000Z',
        },
      }),
    );

    const noOp = reducer.apply(
      requested,
      buildEvent({
        type: 'worktree.merge_executed',
        sequence: 2,
        data: { integrationRef: INT_REF },
      }),
    );
    expect(noOp).toBe(requested);
    expect(noOp.inFlightMerges[INT_REF].operationId).toBe('op-current');
  });

  /**
   * A probe finds that the holder of a reservation is dead and emits
   * `worktree.orphan_detected`. The fold sets the state to `orphan` and clears
   * the owner. A later release sets the state to `released`.
   */
  it('WorktreesProjection_ProbeFinding_EmitsAndFoldsOrphanDetected', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const reserved = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.reserved',
        sequence: 1,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: 8484,
          ownerStartedAt: '2026-06-25T07:00:00.000Z',
          operationId: 'op-res',
        },
      }),
    );
    expect(reserved.worktrees[WT_A].state).toBe('reserved');
    expect(reserved.worktrees[WT_A].ownerPid).toBe(8484);

    const orphaned = reducer.apply(
      reserved,
      buildEvent({
        type: 'worktree.orphan_detected',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: null,
          ownerStartedAt: null,
          operationId: 'op-orphan',
        },
      }),
    );
    expect(orphaned.worktrees[WT_A].state).toBe('orphan');
    expect(orphaned.worktrees[WT_A].ownerPid).toBeNull();
    expect(orphaned.worktrees[WT_A].ownerStartedAt).toBeNull();
    expect(orphaned.projectionSequence).toBe(2);

    const released = reducer.apply(
      orphaned,
      buildEvent({
        type: 'worktree.released',
        sequence: 3,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-rel' },
      }),
    );
    expect(released.worktrees[WT_A].state).toBe('released');
    expect(released.worktrees[WT_A].ownerPid).toBeNull();
  });

  /**
   * The log mixes lifecycle events with merge-lease events on one stream. The
   * cold replay must equal the live fold. `INT_REF` is requested and executed,
   * so only `INT_REF_OTHER` stays in flight, and `WT_A` ends as `orphan`.
   */
  it('WorktreesProjection_ColdRebuild_EqualsLiveState', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const log: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 2,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/a',
          operationId: 'op-m-1',
          holderPid: 11,
          holderStartedAt: '2026-06-25T08:00:00.000Z',
        },
      }),
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 3,
        data: {
          integrationRef: INT_REF_OTHER,
          sourceBranch: 'task/b',
          operationId: 'op-m-2',
          holderPid: 22,
          holderStartedAt: '2026-06-25T09:00:00.000Z',
          worktreeId: WT_A,
        },
      }),
      buildEvent({
        type: 'worktree.merge_executed',
        sequence: 4,
        data: { integrationRef: INT_REF, operationId: 'op-m-1', status: 'merged', mergeSha: 'sha-1' },
      }),
      buildEvent({
        type: 'worktree.orphan_detected',
        sequence: 5,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: null,
          ownerStartedAt: null,
          operationId: 'op-orphan',
        },
      }),
    ];

    let live = reducer.initial;
    for (const ev of log) {
      live = reducer.apply(live, ev);
    }

    const cold = log.reduce((acc, ev) => reducer.apply(acc, ev), reducer.initial);

    expect(cold).toEqual(live);
    expect(Object.keys(cold.inFlightMerges)).toEqual([INT_REF_OTHER]);
    expect(cold.inFlightMerges[INT_REF_OTHER].worktreeId).toBe(WT_A);
    expect(cold.worktrees[WT_A].state).toBe('orphan');
  });

  /** The merge and lifecycle folds must not change the frozen state, in either event order. */
  it('WorktreesReducer_AssertReducerImmutable_Passes', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const events: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 2,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/a',
          operationId: 'op-m-1',
          holderPid: 11,
          holderStartedAt: '2026-06-25T08:00:00.000Z',
        },
      }),
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 3,
        data: {
          integrationRef: INT_REF_OTHER,
          sourceBranch: 'task/b',
          operationId: 'op-m-2',
          holderPid: 22,
          holderStartedAt: '2026-06-25T09:00:00.000Z',
        },
      }),
      buildEvent({
        type: 'worktree.merge_executed',
        sequence: 4,
        data: { integrationRef: INT_REF, operationId: 'op-m-1', status: 'merged', mergeSha: 'sha-1' },
      }),
      buildEvent({
        type: 'worktree.orphan_detected',
        sequence: 5,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: 'feat-a',
          ownerPid: null,
          ownerStartedAt: null,
          operationId: 'op-orphan',
        },
      }),
      buildEvent({
        type: 'worktree.released',
        sequence: 6,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-rel' },
      }),
    ];

    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
    expect(() => assertReducerImmutable(reducer, [...events].reverse())).not.toThrow();
  });
});

/** The `reserveWtA` helper reserves `WT_A` first, because the launcher reserves before it launches a child. */
describe('worktreesReducer.apply — launcher launch liveness folding (DR-2)', () => {
  function reserveWtA(reducer: ReturnType<typeof createWorktreesReducer>) {
    return reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.reserved',
        sequence: 1,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: null,
          ownerPid: 4242,
          ownerStartedAt: '2026-06-25T04:00:00.000Z',
          operationId: 'op-res',
        },
      }),
    );
  }

  /**
   * `launch.executing_started` sets the `launch` marker with the holder fields,
   * and the reservation state stays. A launch event for an unknown worktree
   * returns the same state, because a launch payload cannot build an entry.
   */
  it('PsProjection_FoldsLaunch_ReflectsInFlight', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const reserved = reserveWtA(reducer);
    expect(reserved.worktrees[WT_A].launch).toBeUndefined();

    const started = reducer.apply(
      reserved,
      buildEvent({
        type: 'launch.executing_started',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          holderPid: 5151,
          holderStartedAt: '2026-06-25T04:30:00.000Z',
        },
      }),
    );

    expect(started.worktrees[WT_A].launch).toEqual({
      holderPid: 5151,
      holderStartedAt: '2026-06-25T04:30:00.000Z',
    });
    expect(started.worktrees[WT_A].state).toBe('reserved');
    expect(started.projectionSequence).toBe(2);

    const orphanLaunch = reducer.apply(
      started,
      buildEvent({
        type: 'launch.executing_started',
        sequence: 3,
        data: { worktreeId: WT_B, holderPid: 9, holderStartedAt: 'x' },
      }),
    );
    expect(orphanLaunch).toBe(started);
  });

  /**
   * The terminal removes the `launch` marker, so the marker does not outlive a
   * real child exit. The cleared entry equals an entry that never launched. A
   * second terminal returns the same state.
   */
  it('PsProjection_LaunchExecuted_ClearsInFlight', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const reserved = reserveWtA(reducer);
    const started = reducer.apply(
      reserved,
      buildEvent({
        type: 'launch.executing_started',
        sequence: 2,
        data: {
          worktreeId: WT_A,
          holderPid: 5151,
          holderStartedAt: '2026-06-25T04:30:00.000Z',
        },
      }),
    );
    expect(started.worktrees[WT_A].launch).toBeDefined();

    const executed = reducer.apply(
      started,
      buildEvent({
        type: 'launch.executed',
        sequence: 3,
        data: { worktreeId: WT_A, exitCode: 0 },
      }),
    );

    expect(executed.worktrees[WT_A].launch).toBeUndefined();
    expect(executed.worktrees[WT_A].state).toBe('reserved');
    expect(executed.projectionSequence).toBe(3);
    expect(executed.worktrees[WT_A]).toEqual(reserved.worktrees[WT_A]);

    const executedAgain = reducer.apply(
      executed,
      buildEvent({
        type: 'launch.executed',
        sequence: 4,
        data: { worktreeId: WT_A, exitCode: 0 },
      }),
    );
    expect(executedAgain).toBe(executed);
  });

  /**
   * A lifecycle event that folds while the child runs must keep the `launch`
   * marker. Only the terminal clears it. Otherwise the projection under-reports
   * a live child. The folds also stay immutable in both event orders.
   */
  it('PsProjection_LaunchInFlight_SurvivesInterleavedLifecycleEvent', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const reserved = reserveWtA(reducer);
    const started = reducer.apply(
      reserved,
      buildEvent({
        type: 'launch.executing_started',
        sequence: 2,
        data: { worktreeId: WT_A, holderPid: 5151, holderStartedAt: 'boot' },
      }),
    );

    const released = reducer.apply(
      started,
      buildEvent({
        type: 'worktree.released',
        sequence: 3,
        data: { worktreeId: WT_A, path: WT_A, featureId: null, operationId: 'op-rel' },
      }),
    );

    expect(released.worktrees[WT_A].state).toBe('released');
    expect(released.worktrees[WT_A].launch).toEqual({
      holderPid: 5151,
      holderStartedAt: 'boot',
    });

    const events: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.reserved',
        sequence: 1,
        data: {
          worktreeId: WT_A,
          path: WT_A,
          featureId: null,
          ownerPid: 4242,
          ownerStartedAt: 'boot',
          operationId: 'op-res',
        },
      }),
      buildEvent({
        type: 'launch.executing_started',
        sequence: 2,
        data: { worktreeId: WT_A, holderPid: 5151, holderStartedAt: 'boot' },
      }),
      buildEvent({
        type: 'worktree.released',
        sequence: 3,
        data: { worktreeId: WT_A, path: WT_A, featureId: null, operationId: 'op-rel' },
      }),
      buildEvent({
        type: 'launch.executed',
        sequence: 4,
        data: { worktreeId: WT_A, exitCode: 0 },
      }),
    ];
    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
    expect(() => assertReducerImmutable(reducer, [...events].reverse())).not.toThrow();
  });
});

describe('worktreesReducer.apply — prune-run liveness folding (DR-3 / INV-10)', () => {
  const PRUNE_OP = 'op-prune-1';
  const REPO_ROOT = toPosix(path.resolve('/srv/repo'));

  /**
   * `prune.executing_started` records an in-flight prune under its
   * `operationId`, with the holder fields as they are. It does not touch the
   * worktree or merge maps. `prune.executed` clears it, and a second terminal
   * returns the same state.
   */
  it('WorktreesReducer_PrunePair_FoldsAndClears', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    const started = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'prune.executing_started',
        sequence: 1,
        data: {
          operationId: PRUNE_OP,
          repoRoot: REPO_ROOT,
          holderPid: 9090,
          holderStartedAt: '2026-07-03T00:00:00.000Z',
        },
      }),
    );
    expect(started.inFlightPrunes[PRUNE_OP]).toEqual({
      operationId: PRUNE_OP,
      repoRoot: REPO_ROOT,
      holderPid: 9090,
      holderStartedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(started.worktrees).toEqual({});
    expect(started.inFlightMerges).toEqual({});
    expect(started.projectionSequence).toBe(1);

    const executed = reducer.apply(
      started,
      buildEvent({
        type: 'prune.executed',
        sequence: 2,
        data: { operationId: PRUNE_OP, deletedCount: 3 },
      }),
    );
    expect(PRUNE_OP in executed.inFlightPrunes).toBe(false);
    expect(executed.inFlightPrunes).toEqual({});
    expect(executed.projectionSequence).toBe(2);

    const executedAgain = reducer.apply(
      executed,
      buildEvent({
        type: 'prune.executed',
        sequence: 3,
        data: { operationId: PRUNE_OP, deletedCount: 0 },
      }),
    );
    expect(executedAgain).toBe(executed);
  });

  /** A claim without `operationId` or `repoRoot` returns the same state, not a partial entry. */
  it('WorktreesReducer_PruneStarted_MissingKeys_LaxNoOp', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const noOp = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'prune.executing_started',
        sequence: 1,
        data: { repoRoot: REPO_ROOT },
      }),
    );
    expect(noOp).toBe(reducer.initial);
    expect(noOp.inFlightPrunes).toEqual({});
  });

  /**
   * The prune pair shares the `worktrees` stream with the lifecycle and merge
   * events. A cold replay must reproduce all three maps. A lifecycle event while
   * the prune is in flight keeps the prune marker.
   */
  it('WorktreesReducer_PrunePair_InterleavesWithLifecycleAndMerge_ColdRebuildEquals', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const log: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'prune.executing_started',
        sequence: 2,
        data: { operationId: PRUNE_OP, repoRoot: REPO_ROOT, holderPid: 7, holderStartedAt: 'boot' },
      }),
      buildEvent({
        type: 'worktree.merge_requested',
        sequence: 3,
        data: {
          integrationRef: INT_REF,
          sourceBranch: 'task/x',
          operationId: 'op-m-1',
          holderPid: 8,
          holderStartedAt: 'boot-m',
        },
      }),
      buildEvent({
        type: 'worktree.released',
        sequence: 4,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-rel' },
      }),
    ];

    let live = reducer.initial;
    for (const ev of log) live = reducer.apply(live, ev);
    const cold = log.reduce((acc, ev) => reducer.apply(acc, ev), reducer.initial);

    expect(cold).toEqual(live);
    expect(cold.inFlightPrunes[PRUNE_OP]).toBeDefined();
    expect(cold.inFlightMerges[INT_REF]).toBeDefined();
    expect(cold.worktrees[WT_A].state).toBe('released');
  });

  /** The prune folds must not change the frozen state, in either event order. */
  it('WorktreesReducer_PrunePair_PassesAssertReducerImmutable', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const events: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'prune.executing_started',
        sequence: 1,
        data: { operationId: PRUNE_OP, repoRoot: REPO_ROOT, holderPid: 9090, holderStartedAt: 'boot' },
      }),
      buildEvent({
        type: 'worktree.adopted',
        sequence: 2,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      buildEvent({
        type: 'prune.executed',
        sequence: 3,
        data: { operationId: PRUNE_OP, deletedCount: 1 },
      }),
    ];
    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
    expect(() => assertReducerImmutable(reducer, [...events].reverse())).not.toThrow();
  });
});

describe('worktrees@v1 registration guard (DR-1)', () => {
  /**
   * `aggregateStream` resolves `worktrees@v1` through the process-wide registry
   * and must not throw `UnknownProjectionIdError`. On an empty `worktrees`
   * stream, it returns the initial state of the reducer at version 0.
   */
  it('Projection_WorktreesV1_IsRegistered_AggregateStreamResolves', async () => {
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
