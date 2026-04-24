import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { appendSnapshot } from '../projections/store.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../projections/rehydration/schema.js';
// Importing this barrel has a side effect: it registers the rehydration
// reducer with the process-wide default registry. Import so the handler's
// registry-based resolution works during this test file.
import '../projections/rehydration/index.js';

import { handleRehydrate } from './rehydrate.js';

/**
 * T031 — `handleRehydrate` happy path
 *
 * Implements DR-5: the rehydrate handler loads the latest snapshot for the
 * `rehydration@v1` projection, tails events since the snapshot's sequence,
 * folds them through the rehydration reducer, and returns the canonical
 * {@link RehydrationDocument}. Envelope wrapping happens at the composite
 * boundary (see `workflow/composite.ts` — `envelopeWrap`), so the handler
 * itself returns a `ToolResult`-shaped value with `data` as the raw
 * document (matching sibling handlers like `handleInit` / `handleGet`).
 */

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'rehydrate-handler-test-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('handleRehydrate — happy path (T031, DR-5)', () => {
  it('RehydrateHandler_KnownFeatureId_ReturnsEnvelopedDocument', async () => {
    // GIVEN: a stream seeded with `workflow.started` + several task.* events
    //   and NO existing snapshot on disk (cold-cache path).
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

    // WHEN: we invoke the handler with the featureId.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: the handler returns a successful ToolResult whose `data` is a
    //   schema-valid canonical rehydration document.
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    const parsed = RehydrationDocumentSchema.safeParse(doc);
    expect(parsed.success).toBe(true);

    expect(doc.v).toBe(1);
    // Every seeded event is handled by the rehydration reducer, so
    // `projectionSequence` must match the count of events.
    expect(doc.projectionSequence).toBe(4);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');

    // taskProgress reflects the folded task.* events. T001 is terminal
    // (completed) and T002 is still assigned — this exercises the reducer's
    // per-task upsert contract through the handler.
    expect(doc.taskProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'T001', status: 'completed' }),
        expect.objectContaining({ id: 'T002', status: 'assigned' }),
      ]),
    );
  });

  it('RehydrateHandler_WithSnapshot_UsesSnapshotPlusTail', async () => {
    // GIVEN: a stream of 8 events, and a snapshot at sequence=5 produced by
    //   folding the first 5 events. The handler must start from the snapshot
    //   state and fold only events strictly after sequence 5.
    const featureId = 'wf-with-snapshot';

    // Prefix events (seq 1..5) — fold these manually to produce the snapshot.
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

    // Build the snapshot by querying and folding the prefix — avoids hand-
    // rolling a RehydrationDocument shape that would drift from the schema.
    const { rehydrationReducer } = await import(
      '../projections/rehydration/reducer.js'
    );
    const prefix = await store.query(featureId);
    let snapshotState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of prefix) {
      snapshotState = rehydrationReducer.apply(snapshotState, ev);
    }

    appendSnapshot(stateDir, featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 5,
      state: snapshotState,
      timestamp: new Date().toISOString(),
    });

    // Tail events (seq 6..8): three additional events that must be folded
    // over the snapshot state.
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

    // WHEN: we invoke the handler.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: the handler returns a document whose projectionSequence equals
    //   the snapshot's sequence (5) plus the 3 tail events = 8.
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.projectionSequence).toBe(8);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.phase).toBe('tdd');

    // Tail folded state: T100 stays completed; T101 promoted assigned→completed
    // by tail; T102 added-then-failed by tail.
    const byId = new Map(doc.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T100')).toBe('completed');
    expect(byId.get('T101')).toBe('completed');
    expect(byId.get('T102')).toBe('failed');
  });

  it('RehydrateHandler_UnknownFeatureId_ReturnsInitialDocument', async () => {
    // GIVEN: no events for this featureId and no snapshot. An empty stream
    //   is a legal state (feature hasn't been started yet) so the handler
    //   returns reducer.initial rather than raising — see completion report
    //   for rationale. This lets callers use rehydrate as a "cold read"
    //   probe without a try/catch.
    const result = await handleRehydrate(
      { featureId: 'never-existed' },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.v).toBe(1);
    expect(doc.projectionSequence).toBe(0);
    expect(doc.taskProgress).toEqual([]);
    expect(doc.blockers).toEqual([]);
    // Initial document still validates under the schema.
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
