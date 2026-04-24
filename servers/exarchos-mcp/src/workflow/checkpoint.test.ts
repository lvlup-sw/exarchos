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
    // handler wrote the full RehydrationDocument, so it must re-parse cleanly
    // and `parsed.sequence` must equal its `projectionSequence`.
    const doc = RehydrationDocumentSchema.parse(parsed.state) as RehydrationDocument;
    expect(parsed.sequence).toBe(doc.projectionSequence);

    // Seeded events: workflow.started (seq 1) + 3 task events (seq 2..4). All
    // four are handled by the rehydration reducer, so projectionSequence = 4.
    expect(doc.projectionSequence).toBe(4);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');

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
    expect(writtenData.projectionSequence).toBe(doc.projectionSequence);
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
    // workflow.started is handled (seeds workflowState.featureId +
    // workflowType), so projectionSequence advances to 1.
    expect(parsed.sequence).toBe(1);

    // The checkpoint_written event is emitted even on an otherwise-empty
    // projection — the cadence and replay machinery downstream rely on every
    // checkpoint producing a written event.
    const events = await store.query(featureId);
    expect(events.some((e) => e.type === 'workflow.checkpoint_written')).toBe(true);
  });
});
