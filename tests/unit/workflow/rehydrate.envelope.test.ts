// Every event that `handleRehydrate` emits carries a canonical envelope: a
// non-empty `correlationId`, a non-empty `source`, and data that passes the
// schema of its event type. The success path emits `workflow.rehydrated`.
// The degraded path emits `workflow.projection_degraded`. A spy on the
// rehydration reducer makes the fold throw to reach the degraded path.
// The projection barrel import registers the rehydration reducer with the
// default registry, which the handler needs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleRehydrate } from '../../../src/workflow/rehydrate.js';
import { initStateFile } from '../../../src/workflow/state-store.js';
import '../../../src/projections/rehydration/index.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import { assertCanonicalEnvelope } from '../../../src/workflow/test-helpers/canonical-envelope.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'rehydrate-envelope-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
  await store.initialize();
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('WorkflowRehydrate_AllEmittedEvents_HaveCanonicalEnvelope', () => {
  /** The success path emits `workflow.rehydrated`. */
  it('rehydrate.ts:613 — workflow.rehydrated event has canonical envelope', async () => {
    const featureId = 'rehydrate-envelope-success';

    await initStateFile(stateDir, featureId, 'feature');
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

    const events = await store.query(featureId);
    const rehydratedEvents = events.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents.length).toBe(1);
    assertCanonicalEnvelope(rehydratedEvents);
  });

  /** The degraded path emits `workflow.projection_degraded`. */
  it('rehydrate.ts:234 — workflow.projection_degraded event has canonical envelope', async () => {
    const featureId = 'rehydrate-envelope-degraded';

    await initStateFile(stateDir, featureId, 'feature');
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
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

      const events = await store.query(featureId);
      const degradedEvents = events.filter(
        (e) => e.type === 'workflow.projection_degraded',
      );
      expect(degradedEvents.length).toBe(1);
      assertCanonicalEnvelope(degradedEvents);
    } finally {
      applySpy.mockRestore();
    }
  });
});
