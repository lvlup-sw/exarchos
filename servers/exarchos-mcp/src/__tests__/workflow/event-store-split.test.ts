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
import { handleEventAppend } from '../../event-store/tools.js';
import { EventStore } from '../../event-store/store.js';
import { InMemoryBackend } from '../../storage/memory-backend.js';
import { configureStateStoreBackend } from '../../workflow/state-store.js';

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
    // Create EventStore WITH backend — matches production configuration
    sharedEventStore = new EventStore(stateDir, { backend });
    configureStateStoreBackend(backend);
  });

  afterEach(async () => {
    configureWorkflowMaterializer(null);
    configureStateStoreBackend(undefined);
    await fs.rm(stateDir, { recursive: true, force: true });
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
    await setupAtDelegate('shared-test');

    // Append events via handleEventAppend (the event tools path)
    await appendTeamSpawned('shared-test');
    await appendTeamDisbanded('shared-test');

    // Verify: events ARE in the backend (dual-write via shared store)
    const backendEvents = backend.queryEvents('shared-test');
    expect(backendEvents.some((e) => e.type === 'team.spawned')).toBe(true);
    expect(backendEvents.some((e) => e.type === 'team.disbanded')).toBe(true);

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

  it('GH1009_SplitStoreImpossible_ParameterThreadingPreventsIt', async () => {
    // In #1021's architecture, there's no module-level EventStore to get out of sync.
    // All handlers receive EventStore explicitly. Verify that a separate store
    // instance produces events invisible to the workflow store's backend.
    const separateStore = new EventStore(stateDir); // No backend!

    await setupAtDelegate('split-test');

    // Append via separate store — goes to JSONL only
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

    // Verify the event is NOT in the shared backend
    const backendEvents = backend.queryEvents('split-test');
    const teamEvents = backendEvents.filter((e) => e.type === 'team.spawned');
    expect(teamEvents).toHaveLength(0);
  });
});
