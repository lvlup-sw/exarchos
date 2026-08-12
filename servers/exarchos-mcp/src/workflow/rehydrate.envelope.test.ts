// ─── rehydrate.envelope (#1325 task α-11) ────────────────────────────────
//
// Property-style assertion: every event emitted by `handleRehydrate`
// carries a canonical envelope — non-empty `correlationId`, registered
// `source`, and per-event-type data schema validates.
//
// Two emission paths in `rehydrate.ts`:
//
//   - Line 234 (degraded path, `buildDegradedResponse`) — when the
//     projection cold-fold fails (reducer throw, snapshot corrupt,
//     event-store unavailable), the handler emits
//     `workflow.projection_degraded` and returns a minimal fallback
//     document. Exercised by spying on the rehydration reducer to throw.
//
//   - Line 613 (success path, audit event) — on a successful hydrate,
//     the handler emits `workflow.rehydrated` as an audit event.
//     Exercised by seeding a stream with workflow.started + task.* events
//     and invoking the handler.
//
// RED expectation: both sites today bypass `buildValidatedEvent` and
// do NOT supply `correlationId` / `source`. The assertion fails today
// and α-12 closes the gap.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { handleRehydrate } from './rehydrate.js';
import { initStateFile } from './state-store.js';
// Importing the projection barrel registers the rehydration reducer
// with the process-wide default registry — needed for handler resolution.
import '../projections/rehydration/index.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import { assertCanonicalEnvelope } from './test-helpers/canonical-envelope.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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
  // Line 613 — success path emits `workflow.rehydrated`
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

  // Line 234 — degraded path emits `workflow.projection_degraded`
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
