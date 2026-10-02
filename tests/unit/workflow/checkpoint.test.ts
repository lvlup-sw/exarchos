// The bare import of the rehydration barrel registers its reducer in the default registry, as production boot does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CheckpointState } from '../../../src/workflow/types.js';
import {
  shouldEnforceCheckpoint,
  type CheckpointEnforcementConfig,
  type CheckpointGateResult,
} from '../../../src/workflow/checkpoint.js';
import { EventStore } from '../../../src/events/store.js';
import { handleInit, handleCheckpoint } from '../../../src/workflow/tools.js';
import { handleRehydrate } from '../../../src/workflow/rehydrate.js';
import { SnapshotRecord } from '../../../src/projections/snapshot-schema.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../../../src/projections/rehydration/schema.js';
import '../../../src/projections/rehydration/index.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

  it('shouldEnforceCheckpoint_ConfiguredThreshold30_UsesConfigValue', () => {
    const config: CheckpointEnforcementConfig = {
      operationThreshold: 30,
      enforceOnPhaseTransition: true,
      enforceOnWaveDispatch: true,
    };

    const checkpointBelow = makeCheckpoint({ operationsSince: 25 });
    const resultBelow = shouldEnforceCheckpoint(checkpointBelow, config, 'phase-transition');
    expect(resultBelow.gated).toBe(false);

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

    const checkpoint = makeCheckpoint({ operationsSince: 100 });
    const result = shouldEnforceCheckpoint(checkpoint, config, 'phase-transition');
    expect(result.gated).toBe(false);
  });
});

/**
 * `handleCheckpoint` resets the operation counter and also materializes the rehydration projection.
 * It folds the event stream, stores a `SnapshotRecord`, and emits `workflow.checkpoint_written` with the projection identity and byte size.
 * The `lines` array in these tests is a one-record view of the latest snapshot in the SQLite `projection_snapshots` table.
 */
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

  /**
   * The stream holds `workflow.started` and three task events, and the reducer handles all four.
   * `handleCheckpoint` appends `workflow.checkpoint` as sequence 5 before the fold, and the reducer does not handle it.
   * Thus the snapshot `sequence` is the store tip 5, while `projectionSequence` stays 4.
   * The snapshot must store the tip, or each later rehydrate fetches the checkpoint event again.
   * `workflow.checkpoint_written` reports the same tip as its `projectionSequence`.
   */
  it('CheckpointHandler_MaterializesProjection_WritesSnapshot', async () => {
    const featureId = 'wf-checkpoint-materialize';

    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

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

    const calledAt = Date.now();
    const result = await handleCheckpoint(
      { featureId, summary: 'T034 materialization checkpoint' },
      stateDir,
      store,
    );
    const returnedAt = Date.now();

    expect(result.success).toBe(true);
    expect(result._meta).toBeDefined();
    expect(result._meta!.checkpointAdvised).toBe(false);

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

    const doc = RehydrationDocumentSchema.parse(parsed.state) as RehydrationDocument;

    expect(doc.projectionSequence).toBe(4);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');

    expect(parsed.sequence).toBe(5);
    expect(parsed.sequence).toBeGreaterThan(doc.projectionSequence);

    const snapshotTime = new Date(parsed.timestamp).getTime();
    expect(Number.isNaN(snapshotTime)).toBe(false);
    expect(snapshotTime).toBeGreaterThanOrEqual(calledAt);
    expect(snapshotTime).toBeLessThanOrEqual(returnedAt);

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
    expect(writtenData.projectionSequence).toBe(parsed.sequence);
    expect(writtenData.byteSize).toBeGreaterThan(0);
  });

  /**
   * With only `workflow.started` in the stream, the checkpoint still writes a snapshot and a `workflow.checkpoint_written` event.
   * The snapshot `sequence` is 2, the tip after `workflow.checkpoint`, and `projectionSequence` is 1.
   */
  it('CheckpointHandler_NoSeededEvents_WritesInitialSnapshot', async () => {
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
    const doc = RehydrationDocumentSchema.parse(parsed.state) as RehydrationDocument;
    expect(doc.projectionSequence).toBe(1);
    expect(parsed.sequence).toBe(2);

    const events = await store.query(featureId);
    expect(events.some((e) => e.type === 'workflow.checkpoint_written')).toBe(true);
  });

  /**
   * The unhandled `gate.executed` and `workflow.checkpoint` events advance the store sequence but not `projectionSequence`.
   * If the snapshot stored `projectionSequence`, rehydrate folds the first `review.completed` again and adds a duplicate blocker.
   * The snapshot reflects the stream before `workflow.checkpoint_written`, so its `sequence` is 6.
   * The test expects two blockers: one from the snapshot and one from the tail after it.
   */
  it('CheckpointThenRehydrate_DoesNotDoubleFoldHandledEvents', async () => {
    const featureId = 'wf-checkpoint-rehydrate-roundtrip';

    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T100' },
    });
    await store.append(featureId, {
      type: 'gate.executed' as import('../../../src/events/schemas.js').EventType,
      source: 'workflow',
      data: { gate: 'lint', passed: true } as Record<string, unknown>,
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T100' },
    });

    await store.append(featureId, {
      type: 'review.completed',
      data: {
        stage: 'quality-review',
        verdict: 'blocked',
        findingsCount: 1,
        summary: 'duplicated under double-fold',
      } as Record<string, unknown>,
    });

    const cpResult = await handleCheckpoint(
      { featureId, summary: 'first cp' },
      stateDir,
      store,
    );
    expect(cpResult.success).toBe(true);

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

    expect(parsed.sequence).toBe(6);
    expect(doc.projectionSequence).toBe(4);
    expect(doc.blockers.length).toBe(1);
    expect(parsed.sequence).toBeGreaterThan(doc.projectionSequence);

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

  /**
   * A throw in the middle of the fold must come back as a structured `PROJECTION_REPLAY_FAILED` error, not escape the handler.
   * The patched `query` throws on its first call after init, which is the hydrate call in `handleCheckpoint`.
   */
  it('CheckpointHandler_HydrateThrows_ReturnsStructuredFailure', async () => {
    const featureId = 'wf-checkpoint-hydrate-throws';
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

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

  /**
   * The idempotency key of `workflow.checkpoint` holds `state._version`.
   * The handler writes the state file, which advances `_version`, only after `workflow.checkpoint_written` succeeds.
   * Thus a retry after a failed second append computes the same key, and the store keeps one `workflow.checkpoint`.
   * Both events go through `appendValidated`, and the test makes its second call fail once.
   */
  it('CheckpointHandler_RetryAfterCheckpointWrittenFails_DoesNotDuplicateCheckpointEvent', async () => {
    const featureId = 'wf-cp-retry-idempotency';
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    const handoff = { context: 'partial-recovery test' };

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
      const first = await handleCheckpoint(
        { featureId, summary: 'attempt 1', handoff },
        stateDir,
        store,
      );
      expect(first.success).toBe(false);
      expect(first.error?.code).toBe('EVENT_APPEND_FAILED');
      expect(first.error?.message).toMatch(/checkpoint_written/);

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

    const events = await store.query(featureId);
    const checkpointEvents = events.filter((e) => e.type === 'workflow.checkpoint');
    expect(checkpointEvents.length).toBe(1);

    const writtenEvents = events.filter((e) => e.type === 'workflow.checkpoint_written');
    expect(writtenEvents.length).toBe(1);
  });
});

/**
 * `handleCheckpoint` validates an optional `handoff` field and stores it in `data.handoff` of `workflow.checkpoint`.
 * A call with no `handoff` still works, and its event data holds no `handoff` key.
 */
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

    const result = await handleCheckpoint(
      { featureId, handoff },
      stateDir,
      store,
    );
    expect(result.success).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as {
      counter: number;
      phase: string;
      featureId: string;
      handoff?: typeof handoff;
    };
    expect(data.handoff).toEqual(handoff);
    expect(data.featureId).toBe(featureId);
    expect(data.counter).toBe(0);
    expect(typeof data.phase).toBe('string');
  });

  it('handleCheckpoint_HandoffPayload_RehydrationProjectsLatestHandoff', async () => {
    const featureId = 'wf-t4-handoff-projects';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(init.success).toBe(true);

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

  /**
   * Two checkpoints in the same phase with different handoffs land two events.
   * The idempotency key holds a truncated SHA-256 digest of the handoff, so the two keys differ.
   */
  it('handleCheckpoint_RefinementSamePhase_LandsSecondEvent_1228Regression', async () => {
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

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(2);
    const dataFirst = events[0]!.data as { handoff?: { context?: string } };
    const dataSecond = events[1]!.data as { handoff?: { context?: string } };
    expect(dataFirst.handoff?.context).toBe('first refinement');
    expect(dataSecond.handoff?.context).toBe('second refinement');
  });

  it('handleCheckpoint_NoHandoff_BackwardCompatible', async () => {
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

    const rh = await handleRehydrate(
      { featureId },
      { stateDir, eventStore: store },
    );
    expect(rh.success).toBe(true);
    const doc = rh.data as RehydrationDocument;
    expect(doc.latestHandoff).toBeUndefined();
  });

  /**
   * A `context` of 2049 characters is one over the cap of 2048.
   * The call fails with `INVALID_INPUT`, and no `workflow.checkpoint` event lands.
   * The cast through `unknown` lets the value reach the handler, where the schema rejects it.
   */
  it('handleCheckpoint_OversizedContext_ReturnsValidationError', async () => {
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

    const oversized = 'x'.repeat(2049);
    const result = await handleCheckpoint(
      { featureId, handoff: { context: oversized } } as unknown as Parameters<
        typeof handleCheckpoint
      >[0],
      stateDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');

    const eventsAfter = await store.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(eventsAfter.length).toBe(0);
  });

  /**
   * The handoff schema is strict, so the unknown `notes` key fails with `INVALID_INPUT` and is not stripped.
   * The error message names the key or calls it unknown, so an operator can find the problem from the envelope.
   */
  it('handleCheckpoint_HandoffWithUnknownKey_ReturnsValidationError', async () => {
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
    expect(result.error?.message).toMatch(/notes|unrecognized|unknown/i);

    const eventsAfter = await store.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(eventsAfter.length).toBe(0);
  });
});
