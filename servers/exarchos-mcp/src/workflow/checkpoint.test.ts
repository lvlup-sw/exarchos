import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
    await rm(stateDir, { recursive: true, force: true });
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
    const sidecarPath = path.join(stateDir, `${featureId}.projections.jsonl`);
    const sidecarRaw = await readFile(sidecarPath, 'utf8');
    const lines = sidecarRaw.split('\n').filter((l) => l.length > 0);
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
    const sidecarPath = path.join(stateDir, `${featureId}.projections.jsonl`);
    const sidecarRaw = await readFile(sidecarPath, 'utf8');
    const lines = sidecarRaw.split('\n').filter((l) => l.length > 0);
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
    const sidecarPath = path.join(stateDir, `${featureId}.projections.jsonl`);
    const sidecarRaw = await readFile(sidecarPath, 'utf8');
    const lines = sidecarRaw.split('\n').filter((l) => l.length > 0);
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
});
