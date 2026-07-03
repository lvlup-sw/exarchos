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

// Integration refs used by the in-flight-merge (DR-4) suite. These are branch
// refs, NOT filesystem paths — `inFlightMerges` is keyed by `integrationRef`,
// which typically maps to no adopted worktree entry (the integration branch is
// the main worktree).
const INT_REF = 'feat/wlm-operational-core';
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
      inFlightMerges: {},
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

  it('WorktreesReducer_RemoveExecuted_DropsByStoredWorktreeId_NoFilesystemAtFoldTime', () => {
    // Fix 7 / INV-1: when the remove event carries the already-canonical
    // `worktreeId` the emitter stamped, the reducer drops by that STORED key and
    // never touches the filesystem — so the cold rebuild is deterministic from
    // the log alone, even after the worktree is gone or on a host with different
    // symlink topology. A resolver that THROWS proves no realpath() runs.
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

    // The executed event stamps the canonical worktreeId; worktreePath would, if
    // resolved, blow up the throwing resolver — but it must be IGNORED here.
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

    // Dropped by the stored key — no throw, entry gone.
    expect(WT_A in removed.worktrees).toBe(false);
    expect(removed.projectionSequence).toBe(2);
  });

  it('WorktreesReducer_PreUnificationHistoryReplay_FoldsWithoutError', () => {
    // Task 009 / requirement 4: the reducer stays TOTAL over pre-unification
    // history. Before the `worktree.remove.*` compensation path was unified onto
    // this stream, remove events were emitted on the `featureId` stream carrying
    // ONLY `worktreePath` (no stamped `worktreeId`), and a remove could target a
    // worktree the log never adopted. A replay that mixes those legacy shapes
    // MUST fold without throwing and drop the entry it can correlate.
    const reducer = createWorktreesReducer(identityRealpath);
    const log: readonly WorkflowEvent[] = [
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
      // Legacy intent-only event (no `worktreeId`) — a no-op in the reducer.
      buildEvent({
        type: 'worktree.remove.requested',
        sequence: 2,
        data: { worktreePath: WT_A, operationId: 'op-1' },
      }),
      // Legacy terminal carrying ONLY `worktreePath` — the realpath fallback
      // canonicalizes it back onto WT_A's stored key and drops the entry.
      buildEvent({
        type: 'worktree.remove.executed',
        sequence: 3,
        data: { worktreePath: WT_A, removed: true, operationId: 'op-1' },
      }),
      // A remove for a worktree NEVER adopted (WT_B) — must be a benign no-op,
      // not a throw, so the fold is total over stranded pre-unification removes.
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

    // WT_A was correlated and dropped; WT_B was never present (no phantom key).
    expect(WT_A in state.worktrees).toBe(false);
    expect(WT_B in state.worktrees).toBe(false);
    // Only the adopt (+1) and WT_A drop (+1) advanced the sequence; the WT_A
    // intent-only requested and the stranded WT_B drop were identity no-ops.
    expect(state.projectionSequence).toBe(2);
  });
});

describe('worktreesReducer.apply — in-flight merges + orphan folding (DR-4)', () => {
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

    // A requested-but-not-yet-executed merge is live in `inFlightMerges`, keyed
    // by its integrationRef and carrying the lease-holder fields verbatim.
    expect(state.inFlightMerges[INT_REF]).toEqual({
      integrationRef: INT_REF,
      operationId: 'op-merge-1',
      sourceBranch: 'task/wlm-oc-003-reducer',
      holderPid: 5151,
      holderStartedAt: '2026-06-25T04:00:00.000Z',
      worktreeId: null,
    });
    // It does NOT leak into the worktreeId-keyed entries map.
    expect(state.worktrees).toEqual({});
    expect(state.projectionSequence).toBe(1);
  });

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
    // The RELEASE half clears the in-flight entry for that integrationRef.
    expect(INT_REF in executed.inFlightMerges).toBe(false);
    expect(executed.inFlightMerges).toEqual({});
    expect(executed.projectionSequence).toBe(2);

    // Idempotent: a release for an already-cleared merge is a no-op (identity).
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

  it('WorktreesProjection_IntegrationMergeWithNoWorktreeEntry_HasHomeInInFlightMerges', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    // Adopt a worktree whose worktreeId is unrelated to the integration ref.
    const adopted = reducer.apply(
      reducer.initial,
      buildEvent({
        type: 'worktree.adopted',
        sequence: 1,
        data: { worktreeId: WT_A, path: WT_A, featureId: 'feat-a', operationId: 'op-1' },
      }),
    );

    // A merge targeting the integration BRANCH — there is NO adopted worktree
    // entry keyed under `integrationRef` (the integration branch IS the main
    // worktree, not an adopted feature worktree).
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

    // No worktree entry is keyed under the integrationRef...
    expect(INT_REF in merged.worktrees).toBe(false);
    // ...yet the merge still has a home in `inFlightMerges`.
    expect(merged.inFlightMerges[INT_REF]).toMatchObject({
      integrationRef: INT_REF,
      sourceBranch: 'task/x',
      holderPid: 7373,
      worktreeId: null,
    });
    // The pre-existing, unrelated worktree entry is left untouched.
    expect(merged.worktrees[WT_A].state).toBe('adopted');
  });

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

    // A stale release correlating to a DIFFERENT operationId must not clear the
    // current claim under the same integrationRef — identity, no sequence bump.
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

  it('WorktreesProjection_MergeExecuted_MissingOperationId_DoesNotClearLease', () => {
    // Fail-closed guard (Sentry #15015231/1): a `worktree.merge_executed` with NO
    // operationId cannot prove lease ownership, so it must clear NOTHING —
    // symmetric with upsertInFlightMerge. Production always stamps an operationId;
    // this guards the reducer against a malformed/legacy event clobbering a live
    // lease and violating the DR-7 serialization guarantee.
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
        data: { integrationRef: INT_REF }, // operationId ABSENT
      }),
    );
    // Identity return (no sequence bump), lease untouched.
    expect(noOp).toBe(requested);
    expect(noOp.inFlightMerges[INT_REF].operationId).toBe('op-current');
  });

  it('WorktreesProjection_ProbeFinding_EmitsAndFoldsOrphanDetected', () => {
    const reducer = createWorktreesReducer(identityRealpath);

    // A live reservation: a process holds the worktree.
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

    // A probe finds the holder dead → `worktree.orphan_detected`. Folding the
    // finding flips the entry's liveness: state becomes `orphan`, owner cleared.
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

    // A subsequent release folds liveness to `released` (owner stays cleared).
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

  it('WorktreesProjection_ColdRebuild_EqualsLiveState', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    // A log interleaving the lifecycle family with the merge-lease pair on the
    // singleton stream — cold replay must reproduce both maps byte-for-byte.
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

    // "Live" — fold each event as it arrives, threading the accumulator.
    let live = reducer.initial;
    for (const ev of log) {
      live = reducer.apply(live, ev);
    }

    // "Cold rebuild" — replay the same persisted log from the seed.
    const cold = log.reduce((acc, ev) => reducer.apply(acc, ev), reducer.initial);

    expect(cold).toEqual(live);
    // INT_REF was requested then executed → cleared; INT_REF_OTHER still live.
    expect(Object.keys(cold.inFlightMerges)).toEqual([INT_REF_OTHER]);
    expect(cold.inFlightMerges[INT_REF_OTHER].worktreeId).toBe(WT_A);
    // WT_A's liveness folded to orphan.
    expect(cold.worktrees[WT_A].state).toBe('orphan');
  });

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

    // Deep-freezes the seed + every intermediate; the merge + lifecycle folds
    // must never mutate the frozen `state` argument in place.
    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
    // Order-independence of the purity property.
    expect(() => assertReducerImmutable(reducer, [...events].reverse())).not.toThrow();
  });
});

describe('worktreesReducer.apply — launcher launch liveness folding (DR-2)', () => {
  /** Reserve WT_A first (the launcher reserves before it launches a child). */
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

  it('PsProjection_FoldsLaunch_ReflectsInFlight', () => {
    const reducer = createWorktreesReducer(identityRealpath);
    const reserved = reserveWtA(reducer);
    // No launch yet → the entry carries no in-flight marker.
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

    // The launcher worktree entry now reflects launch-in-flight, carrying the
    // live-child liveness ground truth. The reservation lifecycle is untouched.
    expect(started.worktrees[WT_A].launch).toEqual({
      holderPid: 5151,
      holderStartedAt: '2026-06-25T04:30:00.000Z',
    });
    expect(started.worktrees[WT_A].state).toBe('reserved');
    expect(started.projectionSequence).toBe(2);

    // A launch event for an unknown worktree is a lax no-op (identity) — no
    // full entry can be constructed from a launch payload alone.
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

    // The terminal CLEARS the in-flight marker — so a permanent launch phantom
    // cannot survive a real child exit. The entry itself remains governed.
    expect(executed.worktrees[WT_A].launch).toBeUndefined();
    expect(executed.worktrees[WT_A].state).toBe('reserved');
    expect(executed.projectionSequence).toBe(3);
    // A cleared entry deep-equals a never-launched one (no phantom `launch` key).
    expect(executed.worktrees[WT_A]).toEqual(reserved.worktrees[WT_A]);

    // Idempotent: a terminal for an already-cleared launch is a no-op (identity).
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

  it('PsProjection_LaunchInFlight_SurvivesInterleavedLifecycleEvent', () => {
    // An in-flight launch marker must not be silently dropped by a lifecycle
    // transition that folds while the child is still running — only the terminal
    // clears it (phantom-safety in the OTHER direction: under-reporting a live
    // launch child, not a stuck phantom).
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

    // Lifecycle state advanced, but the launch marker carried forward untouched.
    expect(released.worktrees[WT_A].state).toBe('released');
    expect(released.worktrees[WT_A].launch).toEqual({
      holderPid: 5151,
      holderStartedAt: 'boot',
    });

    // Immutability holds across the interleaved launch + lifecycle folds.
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
