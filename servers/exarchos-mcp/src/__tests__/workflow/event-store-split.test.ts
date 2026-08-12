/**
 * Regression test for GitHub #1009: _events hydration fails silently
 * when the event tools module creates a separate EventStore instance
 * from the workflow tools module.
 *
 * Original root cause: event-store/tools.ts:getStore() lazily created a new
 * EventStore without the StorageBackend, while workflow/tools.ts used
 * a pre-configured instance with the backend.
 *
 * Fix (PR #1021): EventStore is threaded via function parameters — no
 * module-level injection. All handlers receive the same EventStore instance
 * through DispatchContext, making the split-store bug architecturally impossible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleSet,
  configureWorkflowMaterializer,
} from '../../workflow/tools.js';
import { handleEventAppend } from '../../events/tools.js';
import { EventStore } from '../../events/store.js';
import { InMemoryBackend } from '../../storage/memory-backend.js';
import { configureStateStoreBackend } from '../../workflow/state-store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

// ─── Valid event data matching type-specific schemas ─────────────────────────

const TEAM_SPAWNED_DATA = {
  featureId: 'test',
  teamSize: 2,
  teammateNames: ['agent-a', 'agent-b'],
  taskCount: 1,
  dispatchMode: 'agent-team',
};

const TEAM_DISBANDED_DATA = {
  totalDurationMs: 3000,
  tasksCompleted: 1,
  tasksFailed: 0,
};

describe('EventStoreSplit_Regression_GH1009', () => {
  let stateDir: string;
  let backend: InMemoryBackend;
  let sharedEventStore: EventStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-split-store-'));
    backend = new InMemoryBackend();
    // v2.11 substrate-cut: the legacy `{ backend }` constructor option
    // was a JSONL-era dual-write read-delegate. Phase 2 removed the
    // write-side replication, so injecting an InMemoryBackend as the
    // read source would shadow the appender's SQLite handle and yield
    // an empty view. The shared-store visibility invariant under test
    // here only cares that writes and reads land on the SAME
    // `EventStore`, which is true with no `backend` option (the read
    // path resolves to the appender's SQLite handle).
    sharedEventStore = new EventStore(stateDir);
    configureStateStoreBackend(backend);
  });

  afterEach(async () => {
    configureWorkflowMaterializer(null);
    configureStateStoreBackend(undefined);
    await rmrfAsync(stateDir);
  });

  /**
   * Set up a feature workflow at delegate phase with tasks complete.
   * EventStore is threaded explicitly via function parameters.
   */
  async function setupAtDelegate(featureId: string): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, stateDir, sharedEventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
      stateDir,
      sharedEventStore,
    );
    await handleSet({ featureId, phase: 'plan' }, stateDir, sharedEventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
      stateDir,
      sharedEventStore,
    );
    await handleSet({ featureId, phase: 'plan-review' }, stateDir, sharedEventStore);
    await handleSet(
      { featureId, updates: { 'planReview.approved': true } },
      stateDir,
      sharedEventStore,
    );
    await handleSet({ featureId, phase: 'delegate' }, stateDir, sharedEventStore);
    await handleSet(
      { featureId, updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      stateDir,
      sharedEventStore,
    );
  }

  async function appendTeamSpawned(stream: string): Promise<void> {
    const result = await handleEventAppend(
      {
        stream,
        event: {
          type: 'team.spawned',
          correlationId: stream,
          source: 'orchestrator',
          data: { ...TEAM_SPAWNED_DATA, featureId: stream },
        },
      },
      stateDir,
      sharedEventStore,
    );
    expect(result.success).toBe(true);
  }

  async function appendTeamDisbanded(stream: string): Promise<void> {
    const result = await handleEventAppend(
      {
        stream,
        event: {
          type: 'team.disbanded',
          correlationId: stream,
          source: 'orchestrator',
          data: TEAM_DISBANDED_DATA,
        },
      },
      stateDir,
      sharedEventStore,
    );
    expect(result.success).toBe(true);
  }

  it('GH1009_WithSharedStore_EventsVisibleToWorkflowHydration', async () => {
    // In #1021's architecture, EventStore is always threaded via parameters.
    // This verifies that events appended via handleEventAppend are visible
    // to workflow hydration when using the same EventStore instance.
    //
    // v2.11 substrate-cut: the legacy "dual-write into the injected
    // StorageBackend" path is gone (`replicateBackend` was removed in
    // Phase 2). The shared-store visibility invariant now holds because
    // both writes and reads go through the AtomicAppender's SQLite
    // backend on the same `EventStore` instance — we verify by querying
    // the store directly rather than the injected `backend` mock.
    await setupAtDelegate('shared-test');

    // Append events via handleEventAppend (the event tools path)
    await appendTeamSpawned('shared-test');
    await appendTeamDisbanded('shared-test');

    // Verify: events ARE visible via the shared EventStore.
    const events = await sharedEventStore.query('shared-test');
    expect(events.some((e) => e.type === 'team.spawned')).toBe(true);
    expect(events.some((e) => e.type === 'team.disbanded')).toBe(true);

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'shared-test', phase: 'review' },
      stateDir,
      sharedEventStore,
    );

    // Assert: Transition succeeds (events visible via shared backend)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  it('GH1009_SplitStoreImpossible_SqliteSubstrateMakesEventStoresShareStorage', async () => {
    // In PR #1021's architecture, EventStore is threaded explicitly via
    // function parameters — there is no module-level instance that could
    // diverge. v2.11's substrate cut adds a stronger second invariant:
    // even if two EventStore instances ARE constructed at the same
    // stateDir, they both resolve to the same `events.db` SQLite handle,
    // so writes via one are visible via queries on the other. The
    // split-store divergence GH #1009 caught is now architecturally
    // doubly-impossible.
    const separateStore = new EventStore(stateDir);

    await setupAtDelegate('split-test');

    const appendResult = await handleEventAppend(
      {
        stream: 'split-test',
        event: {
          type: 'team.spawned',
          correlationId: 'split-test',
          source: 'orchestrator',
          data: { ...TEAM_SPAWNED_DATA, featureId: 'split-test' },
        },
      },
      stateDir,
      separateStore,
    );
    expect(appendResult.success).toBe(true);

    // The event written via `separateStore` is visible to `sharedEventStore`
    // because both back onto the same SQLite file. This pins the new
    // post-substrate-cut invariant: stateDir is the unit of isolation,
    // not the EventStore instance.
    const sharedEvents = await sharedEventStore.query('split-test');
    expect(sharedEvents.some((e) => e.type === 'team.spawned')).toBe(true);
  });
});
