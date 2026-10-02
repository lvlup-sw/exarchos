// Tests for `handleRehydrate`. The handler loads the latest snapshot of the
// `rehydration@v1` projection, folds the events after the snapshot sequence,
// and returns the rehydration document as `data`. The composite boundary adds
// the envelope. The rehydration barrel import registers the reducer with the
// default registry, which the handler needs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { appendSnapshot, readLatestSnapshot } from '../../../src/projections/store.js';
import { rebuildProjection, projectAt } from '../../../src/projections/rebuild.js';
import {
  REHYDRATION_PROJECTION_ID,
  REHYDRATION_PROJECTION_VERSION,
} from '../../../src/projections/rehydration/identity.js';
import { handleInit, handleCheckpoint } from '../../../src/workflow/tools.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../../../src/projections/rehydration/schema.js';
import type {
  WorkflowRehydrated,
  WorkflowProjectionDegraded,
  WorkflowEvent,
} from '../../../src/events/schemas.js';
import '../../../src/projections/rehydration/index.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import { initStateFile } from '../../../src/workflow/state-store.js';

import {
  handleRehydrate,
  classifyArtifactLayout,
  hydrateFromSnapshotThenTail,
} from '../../../src/workflow/rehydrate.js';

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'rehydrate-handler-test-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('handleRehydrate — happy path (T031, DR-5)', () => {
  /** With no snapshot, the handler folds all four events, so `projectionSequence` is 4. */
  it('RehydrateHandler_KnownFeatureId_ReturnsEnvelopedDocument', async () => {
    const featureId = 'rehydrate-foundation';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
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

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    const parsed = RehydrationDocumentSchema.safeParse(doc);
    expect(parsed.success).toBe(true);

    expect(doc.v).toBe(4);
    expect(doc.projectionSequence).toBe(4);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');

    expect(doc.taskProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'T001', status: 'complete' }),
        expect.objectContaining({ id: 'T002', status: 'in_progress' }),
      ]),
    );
  });

  /** The handler starts from a snapshot at sequence 5 and folds only the three later events. */
  it('RehydrateHandler_WithSnapshot_UsesSnapshotPlusTail', async () => {
    const featureId = 'wf-with-snapshot';

    const prefixEvents = [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      { type: 'workflow.transition', data: { from: 'design', to: 'tdd' } },
      { type: 'task.assigned', data: { taskId: 'T100' } },
      { type: 'task.completed', data: { taskId: 'T100' } },
      { type: 'task.assigned', data: { taskId: 'T101' } },
    ] as const;
    for (const ev of prefixEvents) {
      await store.append(featureId, ev);
    }

    const { rehydrationReducer } = await import(
      '../../../src/projections/rehydration/reducer.js'
    );
    const prefix = await store.query(featureId);
    let snapshotState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of prefix) {
      snapshotState = rehydrationReducer.apply(snapshotState, ev);
    }

    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 5,
      state: snapshotState,
      timestamp: new Date().toISOString(),
    });

    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T101' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T102' },
    });
    await store.append(featureId, {
      type: 'task.failed',
      data: { taskId: 'T102' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.projectionSequence).toBe(8);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.phase).toBe('tdd');

    const byId = new Map(doc.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T100')).toBe('complete');
    expect(byId.get('T101')).toBe('complete');
    expect(byId.get('T102')).toBe('failed');
  });

  /** An empty stream is a legal state, so the handler returns the initial document and does not throw. */
  it('RehydrateHandler_UnknownFeatureId_ReturnsInitialDocument', async () => {
    const result = await handleRehydrate(
      { featureId: 'never-existed' },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.v).toBe(4);
    expect(doc.projectionSequence).toBe(0);
    expect(doc.taskProgress).toEqual([]);
    expect(doc.blockers).toEqual([]);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

/**
 * A cold probe of a feature that was never initialized has no side effects.
 * The handler returns success, appends no `workflow.rehydrated` event, and sets `_meta.workflowExists` to false.
 * An appended event creates a phantom workflow: a stream with no `workflow.started` event.
 */
describe('handleRehydrate — cold probe is side-effect-free (CB-2)', () => {
  it('RehydrateHandler_ColdProbeOfNonExistentFeature_EmitsNoEventAndFlagsAbsent', async () => {
    const featureId = 'never-init-cold-probe';

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const all = await store.query(featureId);
    expect(all).toHaveLength(0);
    expect(result._meta?.workflowExists).toBe(false);
  });

  /** The handler suppresses the audit event only for an empty stream. */
  it('RehydrateHandler_ProbeOfExistingFeature_FlagsPresentAndStillEmits', async () => {
    const featureId = 'exists-warm-probe';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    expect(result._meta?.workflowExists).toBe(true);
    const all = await store.query(featureId);
    expect(all.filter((e) => e.type === 'workflow.rehydrated')).toHaveLength(1);
  });
});

/**
 * After a successful rehydrate, the handler appends one `workflow.rehydrated` event.
 * Its data holds `projectionSequence`, `deliveryPath`, and `tokenEstimate`.
 * `deliveryPath` comes from the arguments and defaults to `direct`.
 */
describe('handleRehydrate — emits workflow.rehydrated (T032, DR-4, DR-5)', () => {
  it('RehydrateHandler_OnSuccess_EmitsRehydratedEvent', async () => {
    const featureId = 'rehydrate-emits-event';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T200' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T200' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T201' },
    });

    const deliveryPath: WorkflowRehydrated['deliveryPath'] = 'direct';

    const result = await handleRehydrate(
      { featureId, deliveryPath },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);

    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.projectionSequence).toBe(4);
    expect(data.deliveryPath).toBe('direct');
    expect(typeof data.tokenEstimate).toBe('number');
    expect(data.tokenEstimate).toBeGreaterThanOrEqual(0);
  });

  it('RehydrateHandler_DefaultDeliveryPath_UsesDirect', async () => {
    const featureId = 'rehydrate-default-delivery';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.deliveryPath).toBe('direct');
    expect(data.projectionSequence).toBe(1);
  });

  /**
   * A store whose `query` throws makes the handler degrade, and the degraded path must not append `workflow.rehydrated`.
   * The stub routes appends to the real store, so a wrong append is visible.
   */
  it('RehydrateHandler_EmitsEvent_OnlyOnSuccess', async () => {
    const featureId = 'rehydrate-failure-no-emit';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const failingStore = {
      append: store.append.bind(store),
      query: async (): Promise<never> => {
        throw new Error('simulated query failure');
      },
    } as unknown as typeof store;

    const result = await handleRehydrate(
      { featureId },
      { eventStore: failingStore, stateDir },
    );
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.degraded).toBe(true);

    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(0);
  });
});

/**
 * When the reducer throws during the fold, the handler does not throw.
 * It appends `workflow.projection_degraded`, reads a minimal state from the state store, and sets `_meta.degraded`.
 * The handler folds with the shared `rehydrationReducer`, so a spy on its `apply` needs no module mock.
 */
describe('handleRehydrate — reducer throw degradation (T054, DR-18)', () => {
  /** The spy folds `workflow.started` and throws on the next event. */
  it('Rehydrate_ReducerThrows_EmitsDegradedAndReturnsMinimalState', async () => {
    const featureId = 'rehydrate-reducer-throws';

    await initStateFile(stateDir, featureId, 'feature');

    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T900' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T900' },
    });

    const realApply = rehydrationReducer.apply.bind(rehydrationReducer);
    let callCount = 0;
    const applySpy = vi
      .spyOn(rehydrationReducer, 'apply')
      .mockImplementation((state, event) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('reducer exploded on T900');
        }
        return realApply(state, event);
      });

    try {
      const result = await handleRehydrate(
        { featureId },
        { eventStore: store, stateDir },
      );

      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(meta?.degraded).toBe(true);
      expect(meta?.fallbackSource).toBe('state-store-only');

      const doc = result.data as RehydrationDocument;
      expect(doc.v).toBe(4);
      expect(doc.projectionSequence).toBe(0);
      expect(doc.workflowState.featureId).toBe(featureId);
      expect(doc.workflowState.workflowType).toBe('feature');
      expect(doc.workflowState.phase).toBeTruthy();
      expect(doc.taskProgress).toEqual([]);
      expect(doc.blockers).toEqual([]);
      expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

      const all = await store.query(featureId);
      const degraded = all.filter(
        (e) => e.type === 'workflow.projection_degraded',
      );
      expect(degraded).toHaveLength(1);
      const payload = degraded[0].data as WorkflowProjectionDegraded;
      expect(payload.projectionId).toBe('rehydration@v1');
      expect(payload.cause).toBe('reducer-throw');
      expect(payload.fallbackSource).toBe('state-store-only');

      const rehydrated = all.filter(
        (e) => e.type === 'workflow.rehydrated',
      );
      expect(rehydrated).toHaveLength(0);
    } finally {
      applySpy.mockRestore();
    }
  });
});

/**
 * When the stored snapshot fails the document schema, the reducer is still healthy, so the handler replays the log from 0.
 * It appends `workflow.projection_degraded` with cause `snapshot-corrupt` and returns the rebuilt document as degraded.
 */
describe('handleRehydrate — corrupt-snapshot degradation (T055, DR-18)', () => {
  it('Rehydrate_CorruptSnapshot_ReplaysFromZeroAndSucceeds', async () => {
    const featureId = 'rehydrate-corrupt-snapshot';

    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T500' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T500' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T501' },
    });

    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 1,
      state: { not: 'a-valid-rehydration-document' } as unknown as RehydrationDocument,
      timestamp: new Date().toISOString(),
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.degraded).toBe(true);
    expect(meta?.fallbackSource).toBe('full-replay');

    const expected = await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    );
    const doc = result.data as RehydrationDocument;
    expect(doc).toEqual(expected);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    const all = await store.query(featureId);
    const degraded = all.filter(
      (e) => e.type === 'workflow.projection_degraded',
    );
    expect(degraded).toHaveLength(1);
    const payload = degraded[0].data as WorkflowProjectionDegraded;
    expect(payload.projectionId).toBe('rehydration@v1');
    expect(payload.cause).toBe('snapshot-corrupt');
    expect(payload.fallbackSource).toBe('full-replay');

    const rehydrated = all.filter((e) => e.type === 'workflow.rehydrated');
    expect(rehydrated).toHaveLength(0);
  });
});

/**
 * When the event store query fails, the handler has no log to fold, so it reads the state store only.
 * It appends `workflow.projection_degraded` with cause `event-stream-unavailable` and returns a minimal degraded document.
 */
describe('handleRehydrate — event-stream-unavailable degradation (T056, DR-18)', () => {
  /** The stub binds `append` and `appendValidated` to the real store, so a later query shows the degraded event. */
  it('Rehydrate_EventStreamUnavailable_ReturnsStateStoreOnly', async () => {
    const featureId = 'rehydrate-event-stream-unavailable';

    await initStateFile(stateDir, featureId, 'feature');

    const failingQueryStore = {
      append: store.append.bind(store),
      appendValidated: store.appendValidated.bind(store),
      query: (): Promise<never> =>
        Promise.reject(new Error('event store offline')),
    } as unknown as typeof store;

    const result = await handleRehydrate(
      { featureId },
      { eventStore: failingQueryStore, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.degraded).toBe(true);
    expect(meta?.fallbackSource).toBe('state-store-only');

    const doc = result.data as RehydrationDocument;
    expect(doc.v).toBe(4);
    expect(doc.projectionSequence).toBe(0);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');
    expect(doc.workflowState.phase).toBeTruthy();
    expect(doc.taskProgress).toEqual([]);
    expect(doc.blockers).toEqual([]);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    const all = await store.query(featureId);
    const degraded = all.filter(
      (e) => e.type === 'workflow.projection_degraded',
    );
    expect(degraded).toHaveLength(1);
    const payload = degraded[0].data as WorkflowProjectionDegraded;
    expect(payload.projectionId).toBe('rehydration@v1');
    expect(payload.cause).toBe('event-stream-unavailable');
    expect(payload.fallbackSource).toBe('state-store-only');

    const rehydrated = all.filter((e) => e.type === 'workflow.rehydrated');
    expect(rehydrated).toHaveLength(0);
  });
});

/**
 * After the fold, the handler attaches the playbook of the current phase to `phasePlaybook`.
 * A phase with no registered playbook gets `null`.
 */
describe('handleRehydrate — phasePlaybook composition (T-20)', () => {
  it('RehydrateHandler_DelegatePhase_AttachesSerializedPhasePlaybook', async () => {
    const featureId = 'rehydrate-phaseplaybook-delegate';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.workflowState.phase).toBe('delegate');
    expect(doc.phasePlaybook).not.toBeNull();
    const playbook = doc.phasePlaybook;
    if (playbook === null) {
      throw new Error('expected phasePlaybook to be non-null');
    }
    expect(playbook.skill).toBe('delegate');
    expect(playbook.events.length).toBeGreaterThan(0);

    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });

  /** A phase with no playbook, such as `shipped`, gets `null` and not an absent field, because the schema requires the field. */
  it('RehydrateHandler_TerminalPhase_AttachesNullPhasePlaybook', async () => {
    const featureId = 'rehydrate-phaseplaybook-terminal';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'shipped' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.workflowState.phase).toBe('shipped');
    expect(doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

/**
 * The `workflow.rehydrated` event carries `phaseHasPlaybook` and `phasePlaybookComposed`.
 * On the success path, both flags equal `phasePlaybook !== null`.
 */
describe('handleRehydrate — workflow.rehydrated extended fields (T-21)', () => {
  it('RehydrateHandler_DelegatePhase_EmitsHasPlaybookAndComposedTrue', async () => {
    const featureId = 'rehydrate-t21-delegate';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.phaseHasPlaybook).toBe(true);
    expect(data.phasePlaybookComposed).toBe(true);
  });

  it('RehydrateHandler_TerminalPhase_EmitsHasPlaybookAndComposedFalse', async () => {
    const featureId = 'rehydrate-t21-terminal';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'shipped' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.phaseHasPlaybook).toBe(false);
    expect(data.phasePlaybookComposed).toBe(false);
  });
});

/**
 * On each of the three degraded paths, the document keeps `phasePlaybook: null`, the default of `rehydrationReducer.initial`.
 * The handler does not compose a playbook for a phase that it cannot trust.
 */
describe('handleRehydrate — degraded paths preserve phasePlaybook null (T-22)', () => {
  it('Rehydrate_ReducerThrows_DegradedDocumentHasPhasePlaybookNull', async () => {
    const featureId = 'rehydrate-t22-reducer-throw';
    await initStateFile(stateDir, featureId, 'feature');
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T22-A' },
    });

    const realApply = rehydrationReducer.apply.bind(rehydrationReducer);
    let callCount = 0;
    const applySpy = vi
      .spyOn(rehydrationReducer, 'apply')
      .mockImplementation((state, event) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('reducer exploded on T22-A');
        }
        return realApply(state, event);
      });

    try {
      const result = await handleRehydrate(
        { featureId },
        { eventStore: store, stateDir },
      );

      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta?.degraded).toBe(true);
      const doc = result.data as RehydrationDocument;
      expect(doc.phasePlaybook).toBeNull();
      expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
    } finally {
      applySpy.mockRestore();
    }
  });

  /** The workflow is in `delegate`, which has a playbook, so the test shows that the degraded path skips composition. */
  it('Rehydrate_CorruptSnapshot_DegradedDocumentHasPhasePlaybookNull', async () => {
    const featureId = 'rehydrate-t22-corrupt-snapshot';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });

    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 1,
      state: { not: 'a-valid-rehydration-document' } as unknown as RehydrationDocument,
      timestamp: new Date().toISOString(),
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.degraded).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('Rehydrate_EventStreamUnavailable_DegradedDocumentHasPhasePlaybookNull', async () => {
    const featureId = 'rehydrate-t22-event-stream-unavailable';
    await initStateFile(stateDir, featureId, 'feature');

    const failingQueryStore = {
      append: store.append.bind(store),
      appendValidated: store.appendValidated.bind(store),
      query: (): Promise<never> =>
        Promise.reject(new Error('event store offline')),
    } as unknown as typeof store;

    const result = await handleRehydrate(
      { featureId },
      { eventStore: failingQueryStore, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.degraded).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

describe('handleRehydrate — projectionAsOf + projectionLag (#1359 / PR4)', () => {
  it('Rehydrate_FoldedEvents_ExposesProjectionAsOf', async () => {
    const featureId = 'pr4-asof';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T001' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta?.projectionAsOf).toBe('string');
    expect(Number.isFinite(Date.parse(meta!.projectionAsOf as string))).toBe(true);
  });

  /** Fake timers set the clock 60 seconds ahead, so the lag is more than the 5-second threshold. */
  it('Rehydrate_StaleProjection_ExposesMetaProjectionLag', async () => {
    const featureId = 'pr4-lag';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const futureMs = Date.now() + 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(futureMs));
    try {
      const result = await handleRehydrate(
        { featureId },
        { eventStore: store, stateDir },
      );
      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(typeof meta?.projectionLag).toBe('number');
      expect(meta?.projectionLag as number).toBeGreaterThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A fresh projection omits `projectionLag`, so a consumer reads the presence of the field as the stale signal. */
  it('Rehydrate_FreshProjection_OmitsProjectionLag', async () => {
    const featureId = 'pr4-fresh';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    if (meta) {
      expect(meta.projectionLag).toBeUndefined();
    }
  });
});

/**
 * A workflow with a legacy design doc and a plan resumes and completes under that layout, with no migration.
 * The handler reports the layout on `_meta.artifactLayout`.
 */
describe('classifyArtifactLayout (DR-9, task 020)', () => {
  it('ClassifyArtifactLayout_LegacyDesignPlusPlan_IsTwoArtifact', () => {
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/2026-06-01-feat.md',
        plan: 'docs/plans/2026-06-01-feat.md',
      }),
    ).toBe('two-artifact');
  });

  /** A spec path under a key other than `spec` also classifies by its path. */
  it('ClassifyArtifactLayout_UnifiedSpec_IsUnified', () => {
    expect(classifyArtifactLayout({ spec: 'docs/specs/2026-06-22-feat.md' })).toBe('unified');
    expect(classifyArtifactLayout({ design: 'docs/specs/2026-06-22-feat.md' })).toBe('unified');
  });

  it('ClassifyArtifactLayout_NoArtifacts_DefaultsUnified', () => {
    expect(classifyArtifactLayout({})).toBe('unified');
  });

  /** A spec artifact wins over a legacy design path, because the workflow already uses the unified layout. */
  it('ClassifyArtifactLayout_SpecWinsOverLegacyDesign_IsUnified', () => {
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/2026-06-01-feat.md',
        spec: 'docs/specs/2026-06-22-feat.md',
      }),
    ).toBe('unified');
  });
});

/**
 * The classifier reads the recorded artifact path and never the filesystem, so a move of a design doc into an archive changes nothing.
 * The legacy design directory must stay the original directory, or a resuming legacy workflow classifies as unified.
 */
describe('LEGACY_DESIGN_DIR archival-invariance (DR-18, task 030)', () => {
  /** The match is a substring match, so a recorded path in a nested archive directory also classifies as `two-artifact`. */
  it('Rehydrate_LegacyDesignPath_ClassificationUnchangedByArchival', () => {
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/2026-05-30-legacy-feat.md',
        plan: 'docs/plans/2026-05-30-legacy-feat.md',
      }),
    ).toBe('two-artifact');

    expect(
      classifyArtifactLayout({
        design: 'docs/designs/archive/2026-05-30-legacy-feat.md',
      }),
    ).toBe('two-artifact');

    expect(classifyArtifactLayout({})).toBe('unified');
  });
});

describe('handleRehydrate — in-flight backward-compat (DR-9, task 020)', () => {
  /** The recorded legacy paths survive as they are, and the handler adds no spec artifact. */
  it('Resume_TwoArtifactInflightWorkflow_CompletesOldPath', async () => {
    const featureId = 'legacy-two-artifact-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: {
        patch: {
          artifacts: {
            design: 'docs/designs/2026-05-30-legacy-feat.md',
            plan: 'docs/plans/2026-05-30-legacy-feat.md',
          },
        },
      },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.artifactLayout).toBe('two-artifact');

    const doc = result.data as RehydrationDocument;
    expect(doc.artifacts.design).toBe('docs/designs/2026-05-30-legacy-feat.md');
    expect(doc.artifacts.plan).toBe('docs/plans/2026-05-30-legacy-feat.md');
    expect(Object.values(doc.artifacts).some((p) => p.includes('docs/specs/'))).toBe(false);
  });

  it('Resume_NewlyInitFeature_UsesUnifiedPath', async () => {
    const featureId = 'fresh-unified-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.artifactLayout).toBe('unified');
  });

  it('Resume_UnifiedSpecWorkflow_StaysUnified', async () => {
    const featureId = 'unified-spec-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: { patch: { artifacts: { spec: 'docs/specs/2026-06-22-feat.md' } } },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.artifactLayout).toBe('unified');
  });
});

/**
 * Pins the snapshot round trip from checkpoint to rehydrate through the production write path.
 * `handleCheckpoint` writes the snapshot. `hydrateFromSnapshotThenTail`, `handleRehydrate`, and `projectAt` read it.
 * A warm read that ignores the snapshot still equals a cold rebuild.
 * Thus the last phase puts a tracer task that no event can produce into the snapshot, and each warm read must return it.
 */
describe('rehydration snapshot round-trip survives the global-scope retirement (DR-1)', () => {
  /**
   * The snapshot sequence is the sequence of the `workflow.checkpoint` event.
   * The handler appends `workflow.checkpoint_written` after the snapshot write, so the tip is one past it.
   * `task.*` folds are idempotent by task id, so only `projectionSequence` shows a tail that a reader applies twice.
   * The handler composes `phasePlaybook` and the snapshot does not hold it, so the comparison drops that field.
   */
  it('RehydrationCheckpoint_AfterGlobalPathRemoval_RoundTripsUnchanged', async () => {
    const featureId = 'roundtrip-after-global-removal';

    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T001' } });
    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T001' } });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T002' } });

    const cpResult = await handleCheckpoint(
      { featureId, summary: 'round-trip guard checkpoint' },
      stateDir,
      store,
    );
    expect(cpResult.success).toBe(true);

    const written = readLatestSnapshot(
      store.getReadBackend(),
      featureId,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );

    expect(written).toBeDefined();
    expect(written!.projectionId).toBe(REHYDRATION_PROJECTION_ID);
    expect(written!.projectionVersion).toBe(REHYDRATION_PROJECTION_VERSION);

    const checkpointSeq = await lastSequenceOfType(store, featureId, 'workflow.checkpoint');
    expect(written!.sequence).toBe(checkpointSeq);
    expect(await tipSequence(store, featureId)).toBe(checkpointSeq + 1);

    const writtenDoc = RehydrationDocumentSchema.parse(written!.state) as RehydrationDocument;
    expect(writtenDoc.projectionSequence).toBeLessThan(written!.sequence);

    const coldAtCheckpoint = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    expect(writtenDoc).toEqual(coldAtCheckpoint);

    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T002' } });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T003' } });
    await store.append(featureId, { type: 'task.failed', data: { taskId: 'T003' } });

    const cold = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;

    expect(cold).not.toEqual(writtenDoc);
    expect(statusById(cold)).toEqual({
      T001: 'complete',
      T002: 'complete',
      T003: 'failed',
    });

    const warmHydrate = await hydrateFromSnapshotThenTail<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      featureId,
      stateDir,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );
    expect(warmHydrate.state).toEqual(cold);
    expect(warmHydrate.lastEventSequence).toBe(await tipSequence(store, featureId));

    const warmProjectAt = await projectAt(rehydrationReducer, store, featureId);
    expect(warmProjectAt).toEqual(cold);

    const handlerResult = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(handlerResult.success).toBe(true);
    const handlerDoc = handlerResult.data as RehydrationDocument;
    expect(withoutPlaybook(handlerDoc)).toEqual(withoutPlaybook(cold));

    const tracerAnchor = await tipSequence(store, featureId);
    const coldAtAnchor = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    const tracerState: RehydrationDocument = {
      ...coldAtAnchor,
      taskProgress: [...coldAtAnchor.taskProgress, { id: TRACER_TASK_ID, status: 'complete' }],
    };
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: tracerAnchor,
      state: tracerState,
      timestamp: new Date().toISOString(),
    });

    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T004' } });

    const coldAfterTracer = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    expect(statusById(coldAfterTracer)).not.toHaveProperty(TRACER_TASK_ID);
    expect(statusById(coldAfterTracer)).toHaveProperty('T004', 'in_progress');

    const expectedStatuses = {
      ...statusById(coldAfterTracer),
      [TRACER_TASK_ID]: 'complete',
    };

    const tracedHydrate = await hydrateFromSnapshotThenTail<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      featureId,
      stateDir,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );
    expect(statusById(tracedHydrate.state)).toEqual(expectedStatuses);
    expect(tracedHydrate.state.projectionSequence).toBe(coldAfterTracer.projectionSequence);

    const tracedProjectAt = (await projectAt(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    expect(statusById(tracedProjectAt)).toEqual(expectedStatuses);
    expect(tracedProjectAt.projectionSequence).toBe(coldAfterTracer.projectionSequence);

    const tracedHandler = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(tracedHandler.success).toBe(true);
    const tracedDoc = tracedHandler.data as RehydrationDocument;
    expect(statusById(tracedDoc)).toEqual(expectedStatuses);
    expect(tracedDoc.projectionSequence).toBe(coldAfterTracer.projectionSequence);
  });
});

/** Task id no event can produce — see the tracer phase above. */
const TRACER_TASK_ID = 'T-SNAPSHOT-TRACER';

/** Highest event-store sequence currently in `streamId`, or 0 when empty. */
async function tipSequence(eventStore: EventStore, streamId: string): Promise<number> {
  const events = await eventStore.query(streamId);
  return events.length > 0 ? events[events.length - 1].sequence : 0;
}

/** Sequence of the last event of `type` in `streamId`. Fails loudly if absent. */
async function lastSequenceOfType(
  eventStore: EventStore,
  streamId: string,
  type: string,
): Promise<number> {
  const matches = (await eventStore.query(streamId)).filter((e) => e.type === type);
  if (matches.length === 0) {
    throw new Error(`expected at least one '${type}' event in stream '${streamId}'`);
  }
  return matches[matches.length - 1].sequence;
}

/** `taskProgress` as an `{ [id]: status }` map for order-insensitive asserts. */
function statusById(doc: RehydrationDocument): Record<string, string> {
  return Object.fromEntries(doc.taskProgress.map((t) => [t.id, t.status]));
}

/**
 * Drop the handler-composed `phasePlaybook` so a handler document can be
 * compared against a raw reducer fold. The playbook is derived from the
 * registry at handler time, not carried through the snapshot.
 */
function withoutPlaybook(doc: RehydrationDocument): Omit<RehydrationDocument, 'phasePlaybook'> {
  const { phasePlaybook: _phasePlaybook, ...rest } = doc;
  return rest;
}

/**
 * The handler returns the event-derived state and never trusts a stale or contradictory projection.
 * The tests read `_meta.rehydrationSource` and `_meta.projectionDegraded` for each degradation mode.
 */
describe('handleRehydrate — degradation precedence (P04-06, EFF-004)', () => {
  /** With no snapshot, the handler folds the event log and reports `event-fold`. */
  it('Rehydrate_ProjectionUnavailable_ReturnsEventDerivedState', async () => {
    const featureId = 'p0406-no-projection';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T001' } });
    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T001' } });

    expect(
      readLatestSnapshot(
        store.getReadBackend(),
        featureId,
        REHYDRATION_PROJECTION_ID,
        REHYDRATION_PROJECTION_VERSION,
      ),
    ).toBeUndefined();

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.rehydrationSource).toBe('event-fold');
    expect(meta?.projectionDegraded).toBeUndefined();

    const doc = result.data as RehydrationDocument;
    expect(doc.projectionSequence).toBe(3);
    expect(statusById(doc)).toEqual({ T001: 'complete' });
  });

  /**
   * A snapshot past the durable tail holds a task that no event produces.
   * The events win, and the response is flagged degraded with reason `projection-ahead`.
   */
  it('Rehydrate_ProjectionContradictsEvents_EventsWin_FlaggedDegraded', async () => {
    const featureId = 'p0406-ahead-contradiction';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T-REAL' } });
    const eventTail = await store.tailSequence(featureId);

    const ghostEvents = [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      { type: 'task.assigned', data: { taskId: 'GHOST' } },
      { type: 'task.completed', data: { taskId: 'GHOST' } },
    ] as const;
    let ghostState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of ghostEvents) {
      ghostState = rehydrationReducer.apply(ghostState, ev as unknown as WorkflowEvent);
    }
    const aheadCursor = eventTail + 8;
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: aheadCursor,
      state: ghostState,
      timestamp: new Date().toISOString(),
    });
    expect(aheadCursor).toBeGreaterThan(eventTail);
    expect(statusById(ghostState)).toHaveProperty('GHOST', 'complete');

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);

    const doc = result.data as RehydrationDocument;
    expect(statusById(doc)).not.toHaveProperty('GHOST');
    expect(statusById(doc)).toHaveProperty('T-REAL', 'in_progress');
    expect(doc.projectionSequence).toBe(2);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.rehydrationSource).toBe('event-fold');
    const degraded = meta?.projectionDegraded as
      | { reason?: string; eventTail?: number; projectionCursor?: number }
      | undefined;
    expect(degraded).toBeDefined();
    expect(degraded?.reason).toBe('projection-ahead');
    expect(degraded?.eventTail).toBe(eventTail);
    expect(degraded?.projectionCursor).toBe(aheadCursor);

    expect(meta?.workflowExists).toBe(true);
  });

  /**
   * A snapshot at the tail holds a task status that a later event changes.
   * The handler folds the tail forward, so the event state wins and the response is not degraded.
   */
  it('Rehydrate_StaleProjectionBehindTail_NotSilentlyTrusted', async () => {
    const featureId = 'p0406-behind-stale';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T-STALE' } });

    const staleCursor = await store.tailSequence(featureId);
    const staleEvents = await store.query(featureId);
    let staleState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of staleEvents) staleState = rehydrationReducer.apply(staleState, ev);
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: staleCursor,
      state: staleState,
      timestamp: new Date().toISOString(),
    });
    expect(statusById(staleState)).toHaveProperty('T-STALE', 'in_progress');

    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T-STALE' } });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(statusById(doc)).toHaveProperty('T-STALE', 'complete');
    expect(doc.projectionSequence).toBe(3);

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.rehydrationSource).toBe('event-fold');
    expect(meta?.projectionDegraded).toBeUndefined();
  });

  /** A cold probe of an unknown feature appends no event and reports `workflowExists: false`. */
  it('Rehydrate_ColdProbeUnknownFeature_NoEvent_WorkflowExistsFalse', async () => {
    const featureId = 'p0406-cold-unknown';
    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.workflowExists).toBe(false);
    expect(meta?.rehydrationSource).toBe('event-fold');
    expect(meta?.projectionDegraded).toBeUndefined();

    const all = await store.query(featureId);
    expect(all).toHaveLength(0);
  });
});
