// ─── Task 0.5 (Wave 0): exarchos_workflow.update concurrency fixture ──────
//
// `update` delegates to `handleSet` which routes its `state.patched` event
// through `eventStore.appendValidated` under the per-stream Promise mutex
// owned by `AtomicAppender`. Two concurrent calls on the same featureId
// with disjoint `updates` payloads must therefore:
//   1. Both succeed.
//   2. Each produce a `state.patched` event at consecutive sequences in
//      the stream (the per-stream lock guarantees the "consecutive"
//      property — interleaving across streams is allowed but within a
//      single stream, sequences are gap-free for a given writer cohort).
//   3. Final state must reflect the union of both patches (a CAS retry
//      on the loser re-reads the winner's state and re-applies its
//      patch, so neither write is dropped).
//
// Pattern derived from event-store/atomic-appender.race.test.ts: fire N
// appends in parallel via Promise.all and assert post-conditions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from './composite.js';
import { handleInit } from './tools.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';
import { configureStateStoreBackend } from './state-store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

let tmpDir: string;
let backend: SqliteBackend;
let eventStore: EventStore;
let ctx: DispatchContext;
const featureId = 'wf-update-race';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-update-race-'));

  // Production-realistic setup: wire a SqliteBackend through both the
  // EventStore (so event appends serialize per-stream via the appender's
  // shared backend) and the module-level state-store backend (so the
  // state-file CAS write is a SQLite transaction with VersionConflict
  // semantics, NOT the file-only write-through path whose temp filename
  // is shared per PID and races on concurrent rename). This matches
  // `core/context.ts:initializeContext`, which is the path every
  // production callsite — CLI dispatch, MCP server — takes. Skipping
  // the backend wiring is a test-only degraded mode that exercises a
  // best-effort backup write whose failure is logged but non-fatal
  // (state-store.ts:343 onward).
  backend = new SqliteBackend(path.join(tmpDir, 'exarchos.db'));
  backend.initialize();
  configureStateStoreBackend(backend);

  eventStore = new EventStore(tmpDir, { backend });
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false, storage: backend };
});

afterEach(async () => {
  // Detach the module-level backend before tearing down so a co-located
  // test that re-imports state-store doesn't observe a half-closed
  // handle. The cast matches the existing pattern in state-store tests.
  configureStateStoreBackend(undefined as unknown as SqliteBackend);
  await rmrfAsync(tmpDir);
});

describe('exarchos_workflow.update — concurrency (Wave 0, Task 0.5)', () => {
  it('WorkflowUpdate_ConcurrentInvocationsSerializeViaPerStreamLock', async () => {
    // Setup: initialize a feature workflow.
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    // Fire two concurrent update calls on the same featureId with
    // disjoint top-level update keys. The per-stream lock inside
    // appendValidated must serialize the two state.patched event
    // appends; the CAS loop in handleSet must re-apply the loser's
    // patch on top of the winner's persisted state so neither field
    // is dropped.
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

    // Both calls must succeed — the lock serializes, it does not
    // reject. Failure here would mean either CAS exhaustion under
    // contention (raise MAX_CAS_RETRIES if so, but the contract is
    // that two concurrent disjoint-field updates always converge) or
    // the lock dropped one writer entirely.
    expect(resA.success).toBe(true);
    expect(resB.success).toBe(true);

    // Both state.patched events must be present in the stream at
    // strictly increasing sequences. The per-stream lock in
    // appendValidated guarantees the two appends do not interleave at
    // the storage layer.
    //
    // Under contention, handleSet's CAS retry path may emit a third
    // state.patched event from the loser on its retry attempt: the
    // idempotency key includes expectedVersion, which differs on the
    // re-read, so the retry appends a NEW event rather than dedup'ing
    // against the original. That's a pre-existing internal behavior of
    // handleSet — Wave 0 restores the *surface*, not internals (see
    // stuck-protocol). Assert >= 2 (at least one append per disjoint
    // patch) and that both patch payloads are observable in the stream
    // so the convergence property is witnessed regardless of retry
    // count.
    const events = await eventStore.query(featureId);
    const patched = events.filter((e) => e.type === 'state.patched');
    expect(patched.length).toBeGreaterThanOrEqual(2);

    // Strictly increasing sequences — per-stream lock invariant.
    for (let i = 1; i < patched.length; i += 1) {
      expect(patched[i]!.sequence).toBeGreaterThan(patched[i - 1]!.sequence);
    }

    // Both patch payloads (artifacts and planReview) must be observable
    // somewhere in the stream — proves the per-stream lock serialized
    // both writers' event emissions rather than collapsing one.
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

    // Final state assertion: union of both patches. The CAS retry
    // ensures the loser re-reads the winner's state before applying
    // its patch, so both top-level fields land. This is the load-
    // bearing convergence property — without it, the second writer's
    // structuredClone of the pre-write state would silently overwrite
    // the first writer's field on the CAS write-back.
    const get = await handleWorkflow({ action: 'get', featureId }, ctx);
    expect(get.success).toBe(true);
    const data = get.data as Record<string, unknown>;
    const artifacts = data.artifacts as Record<string, unknown> | undefined;
    const planReview = data.planReview as Record<string, unknown> | undefined;
    expect(artifacts?.design).toBe('A.md');
    expect(planReview?.approved).toBe(true);
  });
});
