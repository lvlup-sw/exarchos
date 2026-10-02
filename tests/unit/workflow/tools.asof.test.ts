// Tests that `handleGet` with `asOf` bounds the event list before it materializes the state.
// The fixture has three events: `workflow.started` at sequence 1, then transitions to `plan-review`
// and to `delegate`. A bound at sequence 1 gives `plan`, a bound at sequence 2 gives `plan-review`,
// and the live get gives `delegate`. An `asOf` past the tail equals the live get.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleInit, handleGet } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { ViewMaterializer } from '../../../src/projections/views/materializer.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../../../src/projections/views/workflow-state-projection.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const FEATURE_ID = 'asof-get-feature';
const TS_STARTED = '2026-06-20T00:00:01.000Z';
const TS_PLAN = '2026-06-20T00:00:02.000Z';
const TS_DELEGATE = '2026-06-20T00:00:03.000Z';

let tmpDir: string;
let eventStore: EventStore;

/** `handleInit` appends `workflow.started` at sequence 1. Then the two transitions follow with fixed timestamps. */
async function seedWorkflow(): Promise<void> {
  await handleInit({ featureId: FEATURE_ID, workflowType: 'feature' }, tmpDir, eventStore);
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

/** `void TS_STARTED` keeps the unused constant referenced for the linter. */
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asof-get-'));
  eventStore = new EventStore(tmpDir);
  const materializer = new ViewMaterializer();
  materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
  void TS_STARTED;
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('handleGet asOf (T7, #1555)', () => {
  it('handleGet_asOfUntilSequence_materializesBoundedState', async () => {
    await seedWorkflow();

    const boundedSeq1 = await handleGet(
      { featureId: FEATURE_ID, asOf: { untilSequence: 1 } },
      tmpDir,
      eventStore,
    );
    expect(boundedSeq1.success).toBe(true);
    expect((boundedSeq1.data as Record<string, unknown>).phase).toBe('plan');

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
    expect(boundedPastTail.data).toEqual(live.data);
    expect((live.data as Record<string, unknown>).phase).toBe('delegate');
  });

  /** The ceiling at the `plan-review` timestamp includes an event at exactly that time and excludes the later `delegate` event. */
  it('handleGet_asOfUntilTimestamp_boundsByTimestamp', async () => {
    await seedWorkflow();

    const bounded = await handleGet(
      { featureId: FEATURE_ID, asOf: { untilTimestamp: TS_PLAN } },
      tmpDir,
      eventStore,
    );
    expect(bounded.success).toBe(true);
    expect((bounded.data as Record<string, unknown>).phase).toBe('plan-review');
  });
});
