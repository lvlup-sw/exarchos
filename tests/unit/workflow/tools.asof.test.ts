import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleInit, handleGet, configureWorkflowMaterializer } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { ViewMaterializer } from '../../../src/projections/views/materializer.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../../../src/projections/views/workflow-state-projection.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

// ─── T7 (#1555) — `asOf` dispatch-core wiring for `handleGet` ────────────────
//
// `handleGet` materializes ES-v2 workflow state from events. With `asOf` it
// must bound the event list to `events[0..N]` BEFORE materialize (the
// `boundEvents` seam), so the projected phase reflects the bounded point, not
// the live tip. `asOf` past the tail equals the unbounded (live) get
// (INV-1 purity: the bound is observationally a left-fold of `events[0..N]`).
//
// Fixture: a feature workflow advanced ideate → plan → delegate via three
// sequenced events:
//   seq 1: workflow.started   (phase ideate)
//   seq 2: workflow.transition to plan
//   seq 3: workflow.transition to delegate
// so a bound at seq 1 yields `ideate`, seq 2 yields `plan`, live yields
// `delegate`. Timestamps are stamped explicitly so `untilTimestamp` is
// deterministic.

const FEATURE_ID = 'asof-get-feature';
const TS_STARTED = '2026-06-20T00:00:01.000Z';
const TS_PLAN = '2026-06-20T00:00:02.000Z';
const TS_DELEGATE = '2026-06-20T00:00:03.000Z';

let tmpDir: string;
let eventStore: EventStore;

async function seedWorkflow(): Promise<void> {
  // handleInit writes the state file (sets _esVersion: 2 — the ES-v2
  // discriminator handleGet keys on) and appends the seq-1 workflow.started
  // event. We then advance the stream with two transition events so the
  // materialized phase diverges from the seq-1 bound.
  await handleInit({ featureId: FEATURE_ID, workflowType: 'feature' }, tmpDir, eventStore);

  // Rewrite the started event's timestamp deterministically by appending the
  // transitions with explicit timestamps after it. (handleInit's started
  // event already exists at seq 1; we leave its timestamp as-is but bound by
  // sequence in the timestamp test via the transition timestamps below.)
  await eventStore.append(FEATURE_ID, {
    type: 'workflow.transition',
    timestamp: TS_PLAN,
    data: { from: 'plan', to: 'plan-review' },
  });
  await eventStore.append(FEATURE_ID, {
    type: 'workflow.transition',
    timestamp: TS_DELEGATE,
    data: { from: 'plan-review', to: 'delegate' },
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asof-get-'));
  eventStore = new EventStore(tmpDir);
  const materializer = new ViewMaterializer();
  materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
  configureWorkflowMaterializer(materializer);
  // Touch TS_STARTED so the constant is referenced and lints clean even if a
  // future test stops using it directly.
  void TS_STARTED;
});

afterEach(async () => {
  configureWorkflowMaterializer(null);
  await rmrfAsync(tmpDir);
});

describe('handleGet asOf (T7, #1555)', () => {
  it('handleGet_asOfUntilSequence_materializesBoundedState', async () => {
    await seedWorkflow();

    // Bound at seq 1 → only workflow.started folded → phase 'ideate'.
    const boundedSeq1 = await handleGet(
      { featureId: FEATURE_ID, asOf: { untilSequence: 1 } },
      tmpDir,
      eventStore,
    );
    expect(boundedSeq1.success).toBe(true);
    // DR-4 (#1581): workflow.started folds to the initial phase, now 'plan'.
    expect((boundedSeq1.data as Record<string, unknown>).phase).toBe('plan');

    // Bound at seq 2 → started + first transition (plan→plan-review).
    const boundedSeq2 = await handleGet(
      { featureId: FEATURE_ID, asOf: { untilSequence: 2 } },
      tmpDir,
      eventStore,
    );
    expect(boundedSeq2.success).toBe(true);
    expect((boundedSeq2.data as Record<string, unknown>).phase).toBe('plan-review');
  });

  it('handleGet_asOfPastTail_equalsLiveGet', async () => {
    await seedWorkflow();

    const live = await handleGet({ featureId: FEATURE_ID }, tmpDir, eventStore);
    const boundedPastTail = await handleGet(
      { featureId: FEATURE_ID, asOf: { untilSequence: 9999 } },
      tmpDir,
      eventStore,
    );

    expect(live.success).toBe(true);
    expect(boundedPastTail.success).toBe(true);
    // asOf past the tip is observationally identical to the live projection.
    expect(boundedPastTail.data).toEqual(live.data);
    expect((live.data as Record<string, unknown>).phase).toBe('delegate');
  });

  it('handleGet_asOfUntilTimestamp_boundsByTimestamp', async () => {
    await seedWorkflow();

    // Timestamp ceiling at the plan transition → includes started + plan
    // (ties at exactly T are included), excludes the later delegate event.
    const bounded = await handleGet(
      { featureId: FEATURE_ID, asOf: { untilTimestamp: TS_PLAN } },
      tmpDir,
      eventStore,
    );
    expect(bounded.success).toBe(true);
    expect((bounded.data as Record<string, unknown>).phase).toBe('plan-review');
  });
});
