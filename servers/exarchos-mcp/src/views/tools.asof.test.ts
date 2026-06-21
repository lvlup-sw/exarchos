// ─── T7 (#1555) — `asOf` dispatch-core wiring for the `workflow_status` view ──
//
// `handleViewWorkflowStatus` materializes a single stream's workflow state
// from events through `queryDeltaEvents`, which has an hwm-relative LRU
// cache. A bounded `asOf` read MUST bypass that cache (mirror the
// correlation-filter precedent): fetch all events, bound to `events[0..N]`,
// and fold from `projection.init()` — never the hwm cache. Otherwise a warm
// unbounded call would leave the bounded fold reading a contaminated base.
//
// This suite primes the cache with an unbounded (live) call FIRST, then
// issues an `asOf`-bounded call. If the bounded call read the warm cache it
// would report the live phase; the assertion that it reports the bounded
// phase is the cache-bypass proof.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleViewWorkflowStatus, resetMaterializerCache } from './tools.js';
import { EventStore } from '../event-store/store.js';

const STREAM_ID = 'asof-status-wf';
const TS_PLAN = '2026-06-20T00:00:02.000Z';

let tmpDir: string;
let store: EventStore;

async function seedStream(): Promise<void> {
  // The workflow-status-view sets phase to the literal 'started' on
  // workflow.started, then `data.to` on each transition. So:
  // seq 1: workflow.started        → phase 'started'
  // seq 2: workflow.transition     → phase 'plan'
  // seq 3: workflow.transition     → phase 'delegate'
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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('handleViewWorkflowStatus asOf (T7, #1555)', () => {
  it('handleView_asOf_boundsEventsAndBypassesCache', async () => {
    await seedStream();

    // Prime the materializer cache with a LIVE (unbounded) call — this writes
    // the hwm-relative cache so a naive bounded read could pick it up.
    const live = await handleViewWorkflowStatus({ workflowId: STREAM_ID }, tmpDir, store);
    expect(live.success).toBe(true);
    expect((live.data as Record<string, unknown>).phase).toBe('delegate');

    // Bounded read at seq 1 → only workflow.started folded → 'started'. If the
    // bounded path read the warm cache (now reading 'delegate' at hwm 3), this
    // would report 'delegate' and fail — the cache-bypass guard.
    const boundedSeq1 = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilSequence: 1 } },
      tmpDir,
      store,
    );
    expect(boundedSeq1.success).toBe(true);
    expect((boundedSeq1.data as Record<string, unknown>).phase).toBe('started');

    // Bounded read at seq 2 → 'plan'.
    const boundedSeq2 = await handleViewWorkflowStatus(
      { workflowId: STREAM_ID, asOf: { untilSequence: 2 } },
      tmpDir,
      store,
    );
    expect(boundedSeq2.success).toBe(true);
    expect((boundedSeq2.data as Record<string, unknown>).phase).toBe('plan');

    // A subsequent LIVE call must still see the full roll-up — the bounded
    // calls never wrote the cache, so 'delegate' is intact.
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
});
