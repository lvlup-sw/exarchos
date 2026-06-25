import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CheckpointState } from './types.js';
import {
  shouldEnforceCheckpoint,
  type CheckpointEnforcementConfig,
  type CheckpointGateResult,
} from './checkpoint.js';
import { EventStore } from '../event-store/store.js';
import { handleInit, handleCheckpoint } from './tools.js';
import { handleRehydrate } from './rehydrate.js';
import { SnapshotRecord } from '../projections/snapshot-schema.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../projections/rehydration/schema.js';
// Importing this barrel side-effect-registers the rehydration reducer with the
// process-wide default registry. The handler under test resolves the reducer
// indirectly via `hydrateFromSnapshotThenTail`, which imports the reducer by
// value, so registration isn't strictly required — but the other handler tests
// do the same import for parity with production boot.
import '../projections/rehydration/index.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── shouldEnforceCheckpoint ─────────────────────────────────────────────────

describe('shouldEnforceCheckpoint', () => {
  const defaultConfig: CheckpointEnforcementConfig = {
    operationThreshold: 20,
    enforceOnPhaseTransition: true,
    enforceOnWaveDispatch: true,
  };

  function makeCheckpoint(overrides: Partial<CheckpointState> = {}): CheckpointState {
    return {
      timestamp: '2026-01-01T00:00:00Z',
      phase: 'implement',
      summary: 'Test checkpoint',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '2026-01-01T00:00:00Z',
      staleAfterMinutes: 120,
      ...overrides,
    };
  }

  it('shouldEnforceCheckpoint_AboveThreshold_ReturnsGated', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 25 });
    const result = shouldEnforceCheckpoint(checkpoint, defaultConfig, 'phase-transition');

    expect(result.gated).toBe(true);
    expect(result.gate).toBe('checkpoint_required');
    expect(result.operationsSince).toBe(25);
    expect(result.threshold).toBe(20);
  });

  it('shouldEnforceCheckpoint_BelowThreshold_ReturnsNotGated', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 10 });
    const result = shouldEnforceCheckpoint(checkpoint, defaultConfig, 'phase-transition');

    expect(result.gated).toBe(false);
    expect(result.gate).toBeUndefined();
    expect(result.operationsSince).toBeUndefined();
    expect(result.threshold).toBeUndefined();
  });

  it('shouldEnforceCheckpoint_MissingState_ReturnsNotGatedWithWarning', () => {
    const resultUndefined = shouldEnforceCheckpoint(undefined, defaultConfig, 'phase-transition');
    expect(resultUndefined.gated).toBe(false);
    expect(resultUndefined.warning).toBe('checkpoint-state-missing');

    const resultNull = shouldEnforceCheckpoint(null, defaultConfig, 'phase-transition');
    expect(resultNull.gated).toBe(false);
    expect(resultNull.warning).toBe('checkpoint-state-missing');
  });

  it('shouldEnforceCheckpoint_PhaseTransitionDisabled_SkipsCheck', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 25 });
    const config: CheckpointEnforcementConfig = {
      ...defaultConfig,
      enforceOnPhaseTransition: false,
    };
    const result = shouldEnforceCheckpoint(checkpoint, config, 'phase-transition');

    expect(result.gated).toBe(false);
    expect(result.gate).toBeUndefined();
  });

  it('shouldEnforceCheckpoint_WaveDispatchDisabled_SkipsCheck', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 25 });
    const config: CheckpointEnforcementConfig = {
      ...defaultConfig,
      enforceOnWaveDispatch: false,
    };
    const result = shouldEnforceCheckpoint(checkpoint, config, 'wave-dispatch');

    expect(result.gated).toBe(false);
    expect(result.gate).toBeUndefined();
  });

  it('shouldEnforceCheckpoint_ExactThreshold_ReturnsGated', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 20 });
    const result = shouldEnforceCheckpoint(checkpoint, defaultConfig, 'phase-transition');

    expect(result.gated).toBe(true);
    expect(result.gate).toBe('checkpoint_required');
    expect(result.operationsSince).toBe(20);
    expect(result.threshold).toBe(20);
  });

  // ─── Config wiring (Task 019) ──────────────────────────────────────────────

  it('shouldEnforceCheckpoint_ConfiguredThreshold30_UsesConfigValue', () => {
    const config: CheckpointEnforcementConfig = {
      operationThreshold: 30,
      enforceOnPhaseTransition: true,
      enforceOnWaveDispatch: true,
    };

    // 25 ops — below custom threshold of 30 → not gated
    const checkpointBelow = makeCheckpoint({ operationsSince: 25 });
    const resultBelow = shouldEnforceCheckpoint(checkpointBelow, config, 'phase-transition');
    expect(resultBelow.gated).toBe(false);

    // 35 ops — above custom threshold of 30 → gated
    const checkpointAbove = makeCheckpoint({ operationsSince: 35 });
    const resultAbove = shouldEnforceCheckpoint(checkpointAbove, config, 'phase-transition');
    expect(resultAbove.gated).toBe(true);
    expect(resultAbove.threshold).toBe(30);
    expect(resultAbove.operationsSince).toBe(35);
  });

  it('shouldEnforceCheckpoint_ConfigDisablesPhaseTransition_SkipsGate', () => {
    const config: CheckpointEnforcementConfig = {
      operationThreshold: 20,
      enforceOnPhaseTransition: false,
      enforceOnWaveDispatch: true,
    };

    // Way above threshold but phase transition enforcement is disabled
    const checkpoint = makeCheckpoint({ operationsSince: 100 });
    const result = shouldEnforceCheckpoint(checkpoint, config, 'phase-transition');
    expect(result.gated).toBe(false);
  });
});

// ─── handleCheckpoint — projection materialization (T034, DR-6) ─────────────
//
// Extends the existing `exarchos_workflow.checkpoint` action so that, in
// addition to resetting the operation counter, it MATERIALIZES the current
// rehydration projection: folds the event stream through the rehydration
// reducer, writes a `SnapshotRecord` to the per-stream sidecar, and emits
// `workflow.checkpoint_written` with the projection identity and byte size.
//
// The counter-reset and `workflow.checkpoint` emission (covered by existing
// tests at `__tests__/workflow/checkpoint.test.ts` and `checkpoint-gate.test.ts`)
// must remain intact — this test asserts additive behavior only.

describe('handleCheckpoint — materializes rehydration projection (T034, DR-6)', () => {
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-materialize-'));
    store = new EventStore(stateDir);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('CheckpointHandler_MaterializesProjection_WritesSnapshot', async () => {
    // GIVEN: an initialized workflow whose event stream has been seeded with a
    //   `workflow.started` event (from init) plus several task events.
    const featureId = 'wf-checkpoint-materialize';

    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    // Seed task events so the rehydration projection has real state to fold
    // (projectionSequence advances once per handled event).
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T001' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T001' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T002' },
    });

    // WHEN: we invoke the checkpoint handler.
    const result = await handleCheckpoint(
      { featureId, summary: 'T034 materialization checkpoint' },
      stateDir,
      store,
    );

    // THEN (1): the call succeeds and preserves the counter-reset behavior —
    //   `_checkpoint.operationsSince` is 0 after the reset (checked via _meta
    //   which returns the slim `{ checkpointAdvised: false }` shape when the
    //   counter is below the advisory threshold).
    expect(result.success).toBe(true);
    expect(result._meta).toBeDefined();
    expect(result._meta!.checkpointAdvised).toBe(false);

    // THEN (2): a projection snapshot sidecar exists at the expected path and
    //   contains a SnapshotRecord for `rehydration@v1`.
    // Post-#1343: snapshot lives in the SQLite substrate's
    // `projection_snapshots` table — no JSONL sidecar to read. The
    // `lines` adapter below preserves the surrounding assertions'
    // shape (a single-record view of the latest snapshot) so the
    // checkpoint contract checks remain unchanged.
    const latestSnapshot = store.getReadBackend().readLatestProjectionSnapshot(
      featureId,
      'rehydration@v1',
      '1',
    );
    const lines = latestSnapshot !== undefined
      ? [JSON.stringify(latestSnapshot)]
      : [];
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const parsed = SnapshotRecord.parse(JSON.parse(lines[lines.length - 1]!));
    expect(parsed.projectionId).toBe('rehydration@v1');
    expect(parsed.projectionVersion).toBe('1');

    // `parsed.state` is typed `unknown` at the SnapshotRecord boundary — the
    // handler wrote the full RehydrationDocument, so it must re-parse cleanly.
    const doc = RehydrationDocumentSchema.parse(parsed.state) as RehydrationDocument;

    // Seeded events: workflow.started (seq 1) + 3 task events (seq 2..4). All
    // four are handled by the rehydration reducer, so projectionSequence = 4.
    expect(doc.projectionSequence).toBe(4);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');

    // `parsed.sequence` MUST be the highest event-store sequence the
    // snapshot reflects — NOT the projection-internal handled-event count.
    // `handleCheckpoint` appends `workflow.checkpoint` (seq 5) BEFORE the
    // snapshot fold, and that event is unhandled by the rehydration
    // reducer, so projectionSequence stays at 4 while the event-store
    // tip is at 5. Storing projectionSequence here would cause a later
    // `rehydrate` call to query `sinceSequence: 4` and re-fetch the
    // checkpoint event on every read — repeated reduces against
    // duplicates would silently corrupt state for any handler that
    // appends to a list (e.g. blockers). Sentry HIGH on PR #1178.
    expect(parsed.sequence).toBe(5);
    expect(parsed.sequence).toBeGreaterThan(doc.projectionSequence);

    // Snapshot's `timestamp` must be a parseable ISO string within a plausible
    // window (strict ISO validation happens inside SnapshotRecord.parse above;
    // this asserts it is close to "now").
    const snapshotTime = new Date(parsed.timestamp).getTime();
    expect(Number.isNaN(snapshotTime)).toBe(false);
    expect(Math.abs(Date.now() - snapshotTime)).toBeLessThan(60_000);

    // THEN (3): the event stream has gained BOTH the existing
    //   `workflow.checkpoint` event AND the new `workflow.checkpoint_written`
    //   event. This preserves the pre-T034 behavior and adds DR-6's written
    //   event. The written event's payload is schema-valid per T006.
    const events = await store.query(featureId);
    const checkpointEvents = events.filter((e) => e.type === 'workflow.checkpoint');
    expect(checkpointEvents.length).toBe(1);

    const writtenEvents = events.filter(
      (e) => e.type === 'workflow.checkpoint_written',
    );
    expect(writtenEvents.length).toBe(1);

    const writtenData = writtenEvents[0]!.data as {
      projectionId: string;
      projectionSequence: number;
      byteSize: number;
    };
    expect(writtenData.projectionId).toBe('rehydration@v1');
    // The event payload's `projectionSequence` reports the absorbed stream
    // position (matches `parsed.sequence` on the snapshot record), NOT the
    // reducer's handled-event count (`doc.projectionSequence`). One
    // operator-facing checkpoint-lag anchor across both surfaces.
    // (CodeRabbit PR #1178 follow-up review.)
    expect(writtenData.projectionSequence).toBe(parsed.sequence);
    expect(writtenData.byteSize).toBeGreaterThan(0);
  });

  it('CheckpointHandler_NoSeededEvents_WritesInitialSnapshot', async () => {
    // GIVEN: a workflow with ONLY the `workflow.started` event from init —
    //   no additional task/state events. Per DR-6 the checkpoint materializes
    //   whatever the current projection is, so a minimal snapshot (sequence 1,
    //   the folded workflow.started event) should still be written.
    const featureId = 'wf-checkpoint-initial';

    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    const result = await handleCheckpoint(
      { featureId },
      stateDir,
      store,
    );
    expect(result.success).toBe(true);

    // The sidecar must exist with one record — even when no task.* events have
    // been seeded, `workflow.started` alone is a handled event.
    // Post-#1343: snapshot lives in the SQLite substrate's
    // `projection_snapshots` table — no JSONL sidecar to read. The
    // `lines` adapter below preserves the surrounding assertions'
    // shape (a single-record view of the latest snapshot) so the
    // checkpoint contract checks remain unchanged.
    const latestSnapshot = store.getReadBackend().readLatestProjectionSnapshot(
      featureId,
      'rehydration@v1',
      '1',
    );
    const lines = latestSnapshot !== undefined
      ? [JSON.stringify(latestSnapshot)]
      : [];
    expect(lines.length).toBe(1);

    const parsed = SnapshotRecord.parse(JSON.parse(lines[0]!));
    expect(parsed.projectionId).toBe('rehydration@v1');
    // Stream tip after init + checkpoint: workflow.started (seq 1) +
    // workflow.checkpoint (seq 2). The latter is unhandled by the
    // rehydration reducer, so the document's projectionSequence stays at
    // 1, but `parsed.sequence` records the true event-store tip (2) so
    // a later rehydrate doesn't re-fetch the checkpoint event.
    const doc = RehydrationDocumentSchema.parse(parsed.state) as RehydrationDocument;
    expect(doc.projectionSequence).toBe(1);
    expect(parsed.sequence).toBe(2);

    // The checkpoint_written event is emitted even on an otherwise-empty
    // projection — the cadence and replay machinery downstream rely on every
    // checkpoint producing a written event.
    const events = await store.query(featureId);
    expect(events.some((e) => e.type === 'workflow.checkpoint_written')).toBe(true);
  });

  it('CheckpointThenRehydrate_DoesNotDoubleFoldHandledEvents', async () => {
    // Regression for the Sentry HIGH on PR #1178: when an unhandled event
    // sits between handled ones, storing `projectionSequence` (count of
    // handled events) instead of the true event-store tip caused a later
    // rehydrate to re-query starting from a stale sinceSequence and
    // re-apply already-folded events. For list-appending reducers (e.g.
    // `applyReviewCompleted` adding to `blockers`) this would silently
    // duplicate entries on every rehydrate.
    const featureId = 'wf-checkpoint-rehydrate-roundtrip';

    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    // Mix handled and unhandled events. `task.assigned` is handled
    // (advances projectionSequence). `gate.executed` is NOT handled by
    // the rehydration reducer (it falls through to the default case)
    // but it DOES advance the event-store sequence. A handled event
    // follows so the snapshot has both sides of the gap.
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T100' },
    });
    await store.append(featureId, {
      // Unhandled by rehydration reducer — increments event-store seq
      // without bumping projectionSequence. This is the gap that the
      // bug widens with every checkpoint.
      type: 'gate.executed' as import('../event-store/schemas.js').EventType,
      source: 'workflow',
      data: { gate: 'lint', passed: true } as Record<string, unknown>,
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T100' },
    });

    // Append a review.completed BLOCKED event — handled by
    // applyReviewCompleted which appends to `blockers`. This is the
    // event whose double-fold would visibly corrupt state under the
    // old semantics.
    await store.append(featureId, {
      type: 'review.completed',
      data: {
        stage: 'quality-review',
        verdict: 'blocked',
        findingsCount: 1,
        summary: 'duplicated under double-fold',
      } as Record<string, unknown>,
    });

    // Take a checkpoint. This will:
    //   1. Append `workflow.checkpoint` (UNHANDLED, advances event-store seq).
    //   2. Fold all events into the rehydration document.
    //   3. Persist a snapshot whose `sequence` is the event-store tip.
    const cpResult = await handleCheckpoint(
      { featureId, summary: 'first cp' },
      stateDir,
      store,
    );
    expect(cpResult.success).toBe(true);

    // Read the snapshot to confirm `sequence` matches the event-store
    // tip, NOT the projection's handled-event count.
    // Post-#1343: snapshot lives in the SQLite substrate's
    // `projection_snapshots` table — no JSONL sidecar to read. The
    // `lines` adapter below preserves the surrounding assertions'
    // shape (a single-record view of the latest snapshot) so the
    // checkpoint contract checks remain unchanged.
    const latestSnapshot = store.getReadBackend().readLatestProjectionSnapshot(
      featureId,
      'rehydration@v1',
      '1',
    );
    const lines = latestSnapshot !== undefined
      ? [JSON.stringify(latestSnapshot)]
      : [];
    const parsed = SnapshotRecord.parse(JSON.parse(lines[lines.length - 1]!));
    const doc = RehydrationDocumentSchema.parse(parsed.state) as RehydrationDocument;

    // Stream tip the snapshot reflects: workflow.started (1) +
    // task.assigned (2) + gate.executed (3) + task.completed (4) +
    // review.completed (5) + workflow.checkpoint (6) = 6. The snapshot
    // is written BEFORE `workflow.checkpoint_written` is appended (seq
    // 7), so the snapshot's `sequence` field correctly trails the
    // post-checkpoint store tip by one. That is the contract: the
    // snapshot reflects state at the moment of the fold.
    expect(parsed.sequence).toBe(6);
    // Handled events: workflow.started, task.assigned, task.completed,
    // review.completed = 4.
    expect(doc.projectionSequence).toBe(4);
    expect(doc.blockers.length).toBe(1);
    expect(parsed.sequence).toBeGreaterThan(doc.projectionSequence);

    // Now rehydrate. The bug would re-apply review.completed because
    // the stale sinceSequence (4) is < the true tip (6), so the query
    // would return [seq 5: gate.executed, seq 6: workflow.checkpoint] —
    // wait, those are unhandled, so even the buggy version doesn't
    // visibly corrupt this case. To force visibility, we now append a
    // SECOND review.completed BLOCKED event AFTER the checkpoint and
    // rehydrate. With the fix, blockers grows to 2. Without the fix,
    // the stale sinceSequence pulls events 5+6+7 (the new review) and
    // ALSO re-pulls events the snapshot already absorbed if the
    // semantics were wrong — but since query is `> sinceSequence`,
    // the corruption shape is "events between projectionSequence and
    // tip get re-fed" — i.e. the original review.completed at seq 4
    // would be re-applied if sinceSequence were stored as 4 and any
    // later code path relied on the projection seq tracking handled
    // events alone. The fix ensures sinceSequence == tipSeq, so only
    // truly new events flow through.
    await store.append(featureId, {
      type: 'review.completed',
      data: {
        stage: 'quality-review',
        verdict: 'blocked',
        findingsCount: 1,
        summary: 'genuinely new blocker',
      } as Record<string, unknown>,
    });

    const rh = await handleRehydrate(
      { featureId },
      { stateDir, eventStore: store },
    );
    expect(rh.success).toBe(true);
    const rhDoc = rh.data as RehydrationDocument;
    // Exactly two blockers — one folded into the snapshot, one folded
    // from the post-snapshot tail. NOT three (which would prove the
    // pre-checkpoint blocker got re-applied via a stale sinceSequence).
    expect(rhDoc.blockers.length).toBe(2);
    expect(
      rhDoc.blockers.filter((b) =>
        (b as { summary?: string }).summary?.includes('duplicated'),
      ).length,
    ).toBe(1);
    expect(
      rhDoc.blockers.filter((b) =>
        (b as { summary?: string }).summary?.includes('genuinely new'),
      ).length,
    ).toBe(1);
  });

  it('CheckpointHandler_HydrateThrows_ReturnsStructuredFailure', async () => {
    // Sentry HIGH on PR #1178: `handleCheckpoint` previously called
    // `hydrateFromSnapshotThenTail` and `appendSnapshot` unwrapped, so a
    // mid-fold throw (transient EIO, sidecar permissions, event store
    // crash) bubbled out of the dispatch envelope and left the workflow
    // state file (counter reset) divergent from the event-store side.
    // The fix wraps both in try/catch and returns
    // PROJECTION_REPLAY_FAILED / SNAPSHOT_WRITE_FAILED. This test
    // proves the hydrate path emits a structured error.
    const featureId = 'wf-checkpoint-hydrate-throws';
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    // Inject a query failure deep inside hydrateFromSnapshotThenTail by
    // patching the eventStore.query method just for the second call.
    // The first call (during init) already happened; the next is from
    // handleCheckpoint's hydrate.
    const realQuery = store.query.bind(store);
    let callCount = 0;
    store.query = (async (...args) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('simulated mid-fold event store crash');
      }
      return realQuery(...(args as Parameters<typeof realQuery>));
    }) as typeof store.query;

    try {
      const result = await handleCheckpoint({ featureId }, stateDir, store);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECTION_REPLAY_FAILED');
      expect(result.error?.message).toMatch(/simulated mid-fold/);
    } finally {
      store.query = realQuery;
    }
  });

  it('CheckpointHandler_RetryAfterCheckpointWrittenFails_DoesNotDuplicateCheckpointEvent', async () => {
    // CodeRabbit major on PR #1297 (tools.ts:930-960):
    //   `checkpointIdempotencyKey` is derived from `state._version`. The
    //   handler appends `workflow.checkpoint` (key includes _version=N),
    //   then `writeStateFile` advances disk _version to N+1, then later
    //   the snapshot fold + `workflow.checkpoint_written` append run.
    //   If those latter steps fail and the operator retries, the next
    //   call reads disk _version=N+1, computes a DIFFERENT idempotency
    //   key, and the event-store dedup misses — the retry appends a
    //   second `workflow.checkpoint` event. End state: two checkpoint
    //   events on the stream for one operator-intended checkpoint, with
    //   the second carrying the same handoff payload as the first.
    //
    //   The fix is to defer `writeStateFile` (the version-advancing
    //   write) until AFTER `workflow.checkpoint_written` succeeds, so
    //   any partial-failure retry reads the same _version=N and
    //   regenerates the same idempotency key — dedup catches it.
    const featureId = 'wf-cp-retry-idempotency';
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    const handoff = { context: 'partial-recovery test' };

    // Inject a single failure on the SECOND emission. Both emissions
    // route through `appendValidated` post-#1325 (workflow.checkpoint
    // first, then workflow.checkpoint_written second). Real-world
    // analogue: transient EIO on the event-store backend after the
    // initial commit landed.
    const realAppendValidated = store.appendValidated.bind(store);
    let appendCount = 0;
    let injecting = true;
    store.appendValidated = (async (...args) => {
      appendCount += 1;
      if (injecting && appendCount === 2) {
        throw new Error('simulated workflow.checkpoint_written append failure');
      }
      return realAppendValidated(...(args as Parameters<typeof realAppendValidated>));
    }) as typeof store.appendValidated;

    try {
      // Attempt 1: fails on the second append.
      const first = await handleCheckpoint(
        { featureId, summary: 'attempt 1', handoff },
        stateDir,
        store,
      );
      expect(first.success).toBe(false);
      expect(first.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(first.error?.message).toMatch(/checkpoint_written/);

      // Operator retries with the same args. Lift the injector first.
      injecting = false;
      const second = await handleCheckpoint(
        { featureId, summary: 'attempt 1', handoff },
        stateDir,
        store,
      );
      expect(second.success).toBe(true);
    } finally {
      store.appendValidated = realAppendValidated;
    }

    // ASSERT: exactly ONE `workflow.checkpoint` event survived the
    // retry. The dedup invariant is the contract: same featureId +
    // phase + version + handoff digest → same idempotency key → one
    // event. Two events here proves the version-advance ordering
    // bug — disk _version moved between the two attempts so the
    // second attempt's key didn't match the first's.
    const events = await store.query(featureId);
    const checkpointEvents = events.filter((e) => e.type === 'workflow.checkpoint');
    expect(checkpointEvents.length).toBe(1);

    // And exactly one `workflow.checkpoint_written` from the successful
    // retry. (The first attempt failed before this event was appended.)
    const writtenEvents = events.filter((e) => e.type === 'workflow.checkpoint_written');
    expect(writtenEvents.length).toBe(1);
  });
});

// ─── T4 (#1240): handleCheckpoint handoff dispatch wiring ────────────────────
//
// T4 of the checkpoint-handoff bundle wires `handleCheckpoint` to accept a
// formal `handoff` field on its input (validated against `HandoffEntryData`
// from `event-store/schemas.ts`, exported by T1) and persist it on the
// emitted `workflow.checkpoint` event's `data.handoff`. Backward compatibility
// is mandatory — pre-#1240 callers (no `handoff`) must continue to work and
// produce events whose `data` has no `handoff` key.
//
// The C3 (#1241) idempotency-key payload-digest fix already reads the field
// off `input` via a typed cast, so the dedup behaviour for both
// no-handoff (digest of `{}`) and refinement (distinct digests) callers is
// already exercised by `tools.test.ts`. This suite asserts the schema-typed
// field flows end-to-end through dispatch, and that the idempotency-digest
// path lets a same-phase, same-version, distinct-handoff refinement land a
// second event (Sentry regression for #1228 — phantom-claim path no longer
// silently drops the second checkpoint).

describe('handleCheckpoint — handoff dispatch wiring (T4, #1240)', () => {
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-handoff-t4-'));
    store = new EventStore(stateDir);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('handleCheckpoint_HandoffPayload_AppendsEventWithData', async () => {
    // GIVEN: an initialized workflow.
    const featureId = 'wf-t4-handoff-payload';
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    const handoff = {
      context: 'Wave 1 implementer team finished T1-T3; T4 dispatch wiring next',
      nextSteps: ['Wire handoff into handleCheckpoint', 'Add CLI flags'],
      suggestions: ['Verify no-handoff backward compatibility'],
    };

    // WHEN: dispatch with a fully-populated handoff.
    const result = await handleCheckpoint(
      { featureId, handoff },
      stateDir,
      store,
    );
    expect(result.success).toBe(true);

    // THEN: the event store has exactly one workflow.checkpoint event and
    // its data carries the handoff field verbatim.
    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as {
      counter: number;
      phase: string;
      featureId: string;
      handoff?: typeof handoff;
    };
    expect(data.handoff).toEqual(handoff);
    // Pre-existing fields are preserved.
    expect(data.featureId).toBe(featureId);
    expect(data.counter).toBe(0);
    expect(typeof data.phase).toBe('string');
  });

  it('handleCheckpoint_HandoffPayload_RehydrationProjectsLatestHandoff', async () => {
    // GIVEN: an initialized workflow.
    const featureId = 'wf-t4-handoff-projects';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: we checkpoint with a handoff payload.
    const ck = await handleCheckpoint(
      {
        featureId,
        handoff: {
          context: 'WORKFLOW_STATE_DIR is the load-bearing env var',
          nextSteps: ['Rebase --onto origin/main <boundary>'],
          suggestions: ['Cross-reference SHAs in CodeRabbit threads'],
        },
      },
      stateDir,
      store,
    );
    expect(ck.success).toBe(true);

    // THEN: rehydrate projects the handoff into latestHandoff.
    const rh = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(rh.success).toBe(true);
    const doc = rh.data as RehydrationDocument;
    expect(doc.latestHandoff?.context).toMatch(/WORKFLOW_STATE_DIR/);
    expect(doc.latestHandoff?.nextSteps).toEqual(['Rebase --onto origin/main <boundary>']);
    expect(doc.recentHandoffs).toHaveLength(1);
    expect(doc.recentHandoffs[0].context).toMatch(/WORKFLOW_STATE_DIR/);
  });

  it('handleCheckpoint_RefinementSamePhase_LandsSecondEvent_1228Regression', async () => {
    // GIVEN: an initialized workflow. Two consecutive checkpoints with no
    // intervening phase transition observe the same `state.phase`. Prior
    // to #1241, the idempotency key was version-only and the second call
    // collided silently. The C3 fix incorporates a sha256 digest of the
    // handoff payload, so distinct-handoff refinements lands distinct
    // events. T4 adds the formal schema field, and this test pins the
    // end-to-end behaviour (#1228 phantom-drop regression).
    const featureId = 'wf-t4-refinement-1228';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(init.success).toBe(true);

    const first = await handleCheckpoint(
      { featureId, handoff: { context: 'first refinement' } },
      stateDir,
      store,
    );
    expect(first.success).toBe(true);

    const second = await handleCheckpoint(
      { featureId, handoff: { context: 'second refinement' } },
      stateDir,
      store,
    );
    expect(second.success).toBe(true);

    // THEN: both events are in the stream — the second was NOT silently
    // suppressed by an idempotency-key collision.
    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(2);
    const dataFirst = events[0]!.data as { handoff?: { context?: string } };
    const dataSecond = events[1]!.data as { handoff?: { context?: string } };
    expect(dataFirst.handoff?.context).toBe('first refinement');
    expect(dataSecond.handoff?.context).toBe('second refinement');
  });

  it('handleCheckpoint_NoHandoff_BackwardCompatible', async () => {
    // GIVEN: an initialized workflow. WHEN: a checkpoint dispatch arrives
    // without any `handoff` field (the historical / pre-#1240 caller
    // shape), THEN the event lands successfully and its `data` does not
    // carry a `handoff` key (so the on-disk JSONL stays semantically
    // identical to pre-#1240 events for these callers).
    const featureId = 'wf-t4-no-handoff';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(init.success).toBe(true);

    const result = await handleCheckpoint({ featureId }, stateDir, store);
    expect(result.success).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as Record<string, unknown>;
    expect('handoff' in data).toBe(false);

    // Also: rehydrate's `latestHandoff` stays undefined.
    const rh = await handleRehydrate(
      { featureId },
      { stateDir, eventStore: store },
    );
    expect(rh.success).toBe(true);
    const doc = rh.data as RehydrationDocument;
    expect(doc.latestHandoff).toBeUndefined();
  });

  it('handleCheckpoint_OversizedContext_ReturnsValidationError', async () => {
    // GIVEN: an initialized workflow. WHEN: a checkpoint dispatch arrives
    // with `context` longer than 2048 bytes (DIM-7 byte cap on
    // HandoffEntryData), THEN the call returns a structured
    // INVALID_INPUT error; no workflow.checkpoint event lands; the
    // counter is NOT reset.
    const featureId = 'wf-t4-oversized-context';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(init.success).toBe(true);

    const eventsBeforeCount = (
      await store.query(featureId, { type: 'workflow.checkpoint' })
    ).length;
    expect(eventsBeforeCount).toBe(0);

    // 2049 ASCII bytes — one over the DIM-7 cap (2048).
    const oversized = 'x'.repeat(2049);
    const result = await handleCheckpoint(
      // Cast through unknown so the over-cap value reaches the handler;
      // the schema rejection at the boundary is what we're testing.
      { featureId, handoff: { context: oversized } } as unknown as Parameters<
        typeof handleCheckpoint
      >[0],
      stateDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');

    // No event landed.
    const eventsAfter = await store.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(eventsAfter.length).toBe(0);
  });

  it('handleCheckpoint_HandoffWithUnknownKey_ReturnsValidationError', async () => {
    // CodeRabbit major on PR #1297 (workflow/schemas.ts:15-19):
    //   `CheckpointHandoffSchema` (and its mirror `HandoffEntryData`)
    //   uses `z.object()`, which silently strips unknown keys. A
    //   malformed payload — typo'd field, future-version field a
    //   pre-#1240 client doesn't know to filter, accidental injection
    //   of a structured-clone artifact — is sanitized away rather
    //   than surfaced. The strictObject contract requires unknown
    //   keys to fail validation so callers see a clear INVALID_INPUT
    //   instead of a silently-stripped persistence.
    const featureId = 'wf-t4-handoff-unknown-key';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(init.success).toBe(true);

    const eventsBeforeCount = (
      await store.query(featureId, { type: 'workflow.checkpoint' })
    ).length;
    expect(eventsBeforeCount).toBe(0);

    const result = await handleCheckpoint(
      // Extra `notes` key is not part of HandoffEntryData; must reject.
      {
        featureId,
        handoff: {
          context: 'valid context',
          notes: 'this is not a real field',
        },
      } as unknown as Parameters<typeof handleCheckpoint>[0],
      stateDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // The error message should name the offending key so operators
    // diagnose the malformed payload directly from the envelope.
    expect(result.error?.message).toMatch(/notes|unrecognized|unknown/i);

    const eventsAfter = await store.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(eventsAfter.length).toBe(0);
  });
});
