/**
 * `asOf` reads of the `workflow_status` view.
 *
 * A bounded `asOf` read must fold the bounded events from `init`, and must not read or write the
 * materializer cache. The first test fills the cache with a live read, then makes bounded reads.
 * A bounded read that reports the bounded phase proves that it did not use the cache.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleViewWorkflowStatus, resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM_ID = 'asof-status-wf';
const TS_PLAN = '2026-06-20T00:00:02.000Z';

let tmpDir: string;
let store: EventStore;

/**
 * Appends three events. The view sets `phase` to `started` on `workflow.started`, then to `data.to`
 * on each transition. Thus sequence 1 gives `started`, 2 gives `plan`, and 3 gives `delegate`.
 */
async function seedStream(): Promise<void> {
  await store.append(STREAM_ID, {
    type: 'workflow.started',
    timestamp: '2026-06-20T00:00:01.000Z',
    data: { featureId: STREAM_ID, workflowType: 'feature' },
  });
  await store.append(STREAM_ID, {
    type: 'workflow.transition',
    timestamp: TS_PLAN,
    data: { from: 'ideate', to: 'plan' },
  });
  await store.append(STREAM_ID, {
    type: 'workflow.transition',
    timestamp: '2026-06-20T00:00:03.000Z',
    data: { from: 'plan', to: 'delegate' },
  });
}

beforeEach(async () => {
  resetMaterializerCache();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asof-status-'));
  store = new EventStore(tmpDir);
});

afterEach(async () => {
  resetMaterializerCache();
  await rmrfAsync(tmpDir);
});

describe('handleViewWorkflowStatus asOf (T7, #1555)', () => {
  /**
   * The live read fills the cache at sequence 3. A bounded read that uses the cache reports
   * `delegate`, so the bounded phases prove the bypass. The last live read checks that the bounded
   * reads left the live result intact.
   */
  it('handleView_asOf_boundsEventsAndBypassesCache', async () => {
    await seedStream();

    const live = await handleViewWorkflowStatus({ workflowId: STREAM_ID }, tmpDir, store);
    expect(live.success).toBe(true);
    expect((live.data as Record<string, unknown>).phase).toBe('delegate');

    const boundedSeq1 = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilSequence: 1 } },
      tmpDir,
      store,
    );
    expect(boundedSeq1.success).toBe(true);
    expect((boundedSeq1.data as Record<string, unknown>).phase).toBe('started');

    const boundedSeq2 = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilSequence: 2 } },
      tmpDir,
      store,
    );
    expect(boundedSeq2.success).toBe(true);
    expect((boundedSeq2.data as Record<string, unknown>).phase).toBe('plan');

    const liveAgain = await handleViewWorkflowStatus({ workflowId: STREAM_ID }, tmpDir, store);
    expect((liveAgain.data as Record<string, unknown>).phase).toBe('delegate');
  });

  it('handleView_asOfPastTail_equalsLiveStatus', async () => {
    await seedStream();

    const live = await handleViewWorkflowStatus({ workflowId: STREAM_ID }, tmpDir, store);
    const boundedPastTail = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilSequence: 9999 } },
      tmpDir,
      store,
    );
    expect(boundedPastTail.success).toBe(true);
    expect(boundedPastTail.data).toEqual(live.data);
  });

  it('handleView_asOfUntilTimestamp_boundsByTimestamp', async () => {
    await seedStream();

    const bounded = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilTimestamp: TS_PLAN } },
      tmpDir,
      store,
    );
    expect(bounded.success).toBe(true);
    expect((bounded.data as Record<string, unknown>).phase).toBe('plan');
  });

  /**
   * The state file holds the current task list of the planner, here three tasks. A live read takes
   * `tasksTotal` from that list. A bounded read must keep the fold count, which is 1 at sequence 2.
   */
  it('handleView_asOfTasksTotal_usesFoldNotTipStateJson (#1555 review)', async () => {
    await store.append(STREAM_ID, {
      type: 'workflow.started',
      timestamp: '2026-06-20T00:00:01.000Z',
      data: { featureId: STREAM_ID, workflowType: 'feature' },
    });
    await store.append(STREAM_ID, {
      type: 'task.assigned',
      timestamp: '2026-06-20T00:00:02.000Z',
      data: { taskId: 'T1' },
    });
    await store.append(STREAM_ID, {
      type: 'task.assigned',
      timestamp: '2026-06-20T00:00:03.000Z',
      data: { taskId: 'T2' },
    });

    await fs.writeFile(
      path.join(tmpDir, `${STREAM_ID}.state.json`),
      JSON.stringify({ tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] }),
    );

    const live = await handleViewWorkflowStatus({ workflowId: STREAM_ID }, tmpDir, store);
    expect((live.data as Record<string, unknown>).tasksTotal).toBe(3);

    const bounded = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilSequence: 2 } },
      tmpDir,
      store,
    );
    expect(bounded.success).toBe(true);
    expect((bounded.data as Record<string, unknown>).tasksTotal).toBe(1);
  });
});
