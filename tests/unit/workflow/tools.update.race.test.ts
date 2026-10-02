// Concurrency test for `exarchos_workflow.update`. Two concurrent updates on one
// feature, with disjoint keys, must both succeed. Their `state.patched` events
// must have strictly increasing sequences, and the final state must hold both
// patches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from '../../../src/workflow/composite.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;
let backend: SqliteBackend;
let eventStore: EventStore;
let ctx: DispatchContext;
const featureId = 'wf-update-race';

/**
 * Wires one `SqliteBackend` into the event store and the state store, as `initializeContext` does in
 * production. So the state CAS write is a SQLite transaction.
 */
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-update-race-'));

  backend = new SqliteBackend(path.join(tmpDir, 'exarchos.db'));
  backend.initialize();
  configureStateStoreBackend(backend);

  eventStore = new EventStore(tmpDir, { backend });
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false, storage: backend };
});

/** Detaches the module-level state-store backend, so a later test does not see a closed handle. */
afterEach(async () => {
  configureStateStoreBackend(undefined as unknown as SqliteBackend);
  await rmrfAsync(tmpDir);
});

describe('exarchos_workflow.update — concurrency (Wave 0, Task 0.5)', () => {
  /**
   * A CAS retry re-reads the state, so the final state holds both patches. The retry can append a third
   * `state.patched` event, because the idempotency key holds `expectedVersion`. So the test asserts at least
   * two events and checks each patch payload.
   */
  it('WorkflowUpdate_ConcurrentInvocationsSerializeViaPerStreamLock', async () => {
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    const callA = handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { artifacts: { design: 'A.md' } },
      },
      ctx,
    );
    const callB = handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { planReview: { approved: true } },
      },
      ctx,
    );

    const [resA, resB] = await Promise.all([callA, callB]);

    expect(resA.success).toBe(true);
    expect(resB.success).toBe(true);

    const events = await eventStore.query(featureId);
    const patched = events.filter((e) => e.type === 'state.patched');
    expect(patched.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < patched.length; i += 1) {
      expect(patched[i].sequence).toBeGreaterThan(patched[i - 1].sequence);
    }

    const hasArtifactsPatch = patched.some((e) => {
      const patch = (e.data as Record<string, unknown>).patch as
        | Record<string, unknown>
        | undefined;
      return (patch?.artifacts as Record<string, unknown> | undefined)?.design === 'A.md';
    });
    const hasPlanReviewPatch = patched.some((e) => {
      const patch = (e.data as Record<string, unknown>).patch as
        | Record<string, unknown>
        | undefined;
      return (patch?.planReview as Record<string, unknown> | undefined)?.approved === true;
    });
    expect(hasArtifactsPatch).toBe(true);
    expect(hasPlanReviewPatch).toBe(true);

    const get = await handleWorkflow({ action: 'get', featureId }, ctx);
    expect(get.success).toBe(true);
    const data = get.data as Record<string, unknown>;
    const artifacts = data.artifacts as Record<string, unknown> | undefined;
    const planReview = data.planReview as Record<string, unknown> | undefined;
    expect(artifacts?.design).toBe('A.md');
    expect(planReview?.approved).toBe(true);
  });
});
