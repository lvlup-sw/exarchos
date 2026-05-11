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

let tmpDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;
const featureId = 'wf-update-race';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-update-race-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
    // consecutive sequences. Querying by type filters out unrelated
    // event types (workflow.started, etc.); ordering preserves append
    // order.
    const events = await eventStore.query(featureId);
    const patched = events.filter((e) => e.type === 'state.patched');
    expect(patched.length).toBe(2);

    // Sequences are integers and strictly increasing across the
    // stream — adjacent state.patched events should differ by 1 if
    // no other event types intervened, but for resilience we only
    // assert strict ordering here. The per-stream lock guarantees
    // they cannot interleave at the storage layer.
    expect(patched[0].sequence).toBeLessThan(patched[1].sequence);

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
