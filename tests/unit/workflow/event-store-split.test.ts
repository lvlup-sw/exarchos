/**
 * Regression test for lvlup-sw/exarchos#1009. Events that `handleEventAppend` writes must be
 * visible to workflow hydration. Every handler receives the `EventStore` through its parameters,
 * so the workflow and event tools share one store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleSet,
  } from '../../../src/workflow/tools.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

  /**
   * The `EventStore` gets no `backend` option. An injected backend replaces the SQLite read path
   * of the appender, and the queries then see no events.
   */
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-split-store-'));
    backend = new InMemoryBackend();
    sharedEventStore = new EventStore(stateDir);
    configureStateStoreBackend(backend);
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined);
    await rmrfAsync(stateDir);
  });

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

  /**
   * Events that `handleEventAppend` writes must be visible to the `delegate` to `review`
   * transition through the same `EventStore`. The test queries the store, not the injected
   * backend, because writes and reads go through the SQLite backend of the store.
   */
  it('GH1009_WithSharedStore_EventsVisibleToWorkflowHydration', async () => {
    await setupAtDelegate('shared-test');

    await appendTeamSpawned('shared-test');
    await appendTeamDisbanded('shared-test');

    const events = await sharedEventStore.query('shared-test');
    expect(events.some((e) => e.type === 'team.spawned')).toBe(true);
    expect(events.some((e) => e.type === 'team.disbanded')).toBe(true);

    const result = await handleSet(
      { featureId: 'shared-test', phase: 'review' },
      stateDir,
      sharedEventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  /**
   * Two `EventStore` instances on the same `stateDir` use the same SQLite file. An event that one
   * instance writes is visible to queries on the other. The unit of isolation is `stateDir`, not
   * the `EventStore` instance.
   */
  it('GH1009_SplitStoreImpossible_SqliteSubstrateMakesEventStoresShareStorage', async () => {
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

    const sharedEvents = await sharedEventStore.query('split-test');
    expect(sharedEvents.some((e) => e.type === 'team.spawned')).toBe(true);
  });
});
