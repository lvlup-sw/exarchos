import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleReconcileState,
} from './tools.js';
import { initStateFile, reconcileFromEvents } from './state-store.js';
import { EventStore } from '../event-store/store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-state-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('handleReconcileState', () => {
  describe('Reconcile_WithStaleTaskState_PatchesFromEvents', () => {
    it('should reconcile stale state from events showing phase transition', async () => {
      // Arrange: Create state at 'ideate' phase, then append events that
      // show a transition to 'plan' without updating the state file
      const eventStore = new EventStore(tmpDir);

      await initStateFile(tmpDir, 'stale-test', 'feature');

      // Append events: workflow.started + workflow.transition
      await eventStore.append('stale-test', {
        type: 'workflow.started',
        data: { featureId: 'stale-test', workflowType: 'feature' },
      });
      await eventStore.append('stale-test', {
        type: 'workflow.transition',
        data: {
          from: 'ideate',
          to: 'plan',
          trigger: 'execute-transition',
          featureId: 'stale-test',
        },
      });

      // Act
      const result = await handleReconcileState(
        { featureId: 'stale-test' },
        tmpDir,
        eventStore,
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        reconciled: true,
        eventsApplied: 2,
      });

      // Verify state file was actually updated
      const stateFile = path.join(tmpDir, 'stale-test.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw.phase).toBe('plan');
    });
  });

  describe('Reconcile_WithEmptyEventStream_ReturnsNoChanges', () => {
    it('should return reconciled:false when no events exist', async () => {
      // Arrange: Create state but append no events
      const eventStore = new EventStore(tmpDir);

      await initStateFile(tmpDir, 'empty-test', 'feature');

      // Act
      const result = await handleReconcileState(
        { featureId: 'empty-test' },
        tmpDir,
        eventStore,
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        reconciled: false,
        eventsApplied: 0,
      });
    });
  });

  describe('Reconcile_MissingFeatureId_ReturnsError', () => {
    it('should return error when featureId is not provided', async () => {
      const eventStore = new EventStore(tmpDir);

      // Act: call without featureId
      const result = await handleReconcileState(
        {} as { featureId: string },
        tmpDir,
        eventStore,
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INVALID_INPUT');
    });
  });

  describe('Reconcile_NoEventStore_ReturnsError', () => {
    it('should return error when no event store is configured', async () => {
      await initStateFile(tmpDir, 'no-store-test', 'feature');

      // Act
      const result = await handleReconcileState(
        { featureId: 'no-store-test' },
        tmpDir,
        null,
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('EVENT_STORE_NOT_CONFIGURED');
    });
  });
});

// ─── T-03: reconcileFromEvents hydrates _events ──────────────────────────────

describe('reconcileFromEvents_HydratesEvents', () => {
  it('Reconcile_WithTeamEvents_HydratesEventsIntoState', async () => {
    // Arrange: Init workflow, append events including team.spawned and team.disbanded
    const eventStore = new EventStore(tmpDir);

    await initStateFile(tmpDir, 'hydrate-test', 'feature');

    await eventStore.append('hydrate-test', {
      type: 'workflow.started',
      data: { featureId: 'hydrate-test', workflowType: 'feature' },
    });
    await eventStore.append('hydrate-test', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'delegate', trigger: 'execute-transition', featureId: 'hydrate-test' },
    });
    await eventStore.append('hydrate-test', {
      type: 'team.spawned' as import('../event-store/schemas.js').EventType,
      data: { featureId: 'hydrate-test', agentCount: 3 },
    });
    await eventStore.append('hydrate-test', {
      type: 'team.disbanded' as import('../event-store/schemas.js').EventType,
      data: { featureId: 'hydrate-test', totalDurationMs: 5000, tasksCompleted: 3, tasksFailed: 0 },
    });

    // Act
    const result = await reconcileFromEvents(tmpDir, 'hydrate-test', eventStore);

    // Assert: reconcile applied events
    expect(result.reconciled).toBe(true);

    // Read state file and verify _events is populated
    const stateFile = path.join(tmpDir, 'hydrate-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const events = raw._events as Array<Record<string, unknown>>;

    expect(events).toBeDefined();
    expect(events.length).toBeGreaterThanOrEqual(4);

    // Verify team events are present with correct types
    const teamSpawned = events.find((e) => e.type === 'team.spawned');
    const teamDisbanded = events.find((e) => e.type === 'team.disbanded');
    expect(teamSpawned).toBeDefined();
    expect(teamDisbanded).toBeDefined();
  });

  it('Reconcile_WithModelEmittedEvents_PreservesAllDataFields', async () => {
    // Arrange
    const eventStore = new EventStore(tmpDir);

    await initStateFile(tmpDir, 'data-test', 'feature');

    await eventStore.append('data-test', {
      type: 'workflow.started',
      data: { featureId: 'data-test', workflowType: 'feature' },
    });
    await eventStore.append('data-test', {
      type: 'team.disbanded' as import('../event-store/schemas.js').EventType,
      data: { totalDurationMs: 5000, tasksCompleted: 3, tasksFailed: 0 },
    });

    // Act
    await reconcileFromEvents(tmpDir, 'data-test', eventStore);

    // Assert: _events entry for team.disbanded has totalDurationMs at top level
    const stateFile = path.join(tmpDir, 'data-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const events = raw._events as Array<Record<string, unknown>>;

    const disbanded = events?.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    expect(disbanded!.totalDurationMs).toBe(5000);
    expect(disbanded!.tasksCompleted).toBe(3);
    expect(disbanded!.tasksFailed).toBe(0);
  });

  it('Reconcile_EventStoreHydrationFails_WarnsButSucceeds', async () => {
    // Arrange: Use a real event store for reconcile loop but make query fail on the 2nd call
    const eventStore = new EventStore(tmpDir);

    await initStateFile(tmpDir, 'fail-hydrate', 'feature');

    await eventStore.append('fail-hydrate', {
      type: 'workflow.started',
      data: { featureId: 'fail-hydrate', workflowType: 'feature' },
    });
    await eventStore.append('fail-hydrate', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'fail-hydrate' },
    });

    // Spy on query: let the first 2 calls succeed (delta + full), fail on subsequent calls
    let callCount = 0;
    const originalQuery = eventStore.query.bind(eventStore);
    const querySpy = vi.spyOn(eventStore, 'query').mockImplementation(
      async (streamId, filters) => {
        callCount++;
        // The reconcile loop queries with sinceSequence (or without filters).
        // The hydration call at the end queries without sinceSequence.
        // Let the first call succeed, fail on the second (hydration).
        if (callCount <= 1) {
          return originalQuery(streamId, filters);
        }
        throw new Error('Hydration query failed');
      },
    );

    // Act
    const result = await reconcileFromEvents(tmpDir, 'fail-hydrate', eventStore);

    // Assert: reconcile still succeeds (event application worked)
    expect(result.reconciled).toBe(true);
    expect(result.eventsApplied).toBeGreaterThanOrEqual(1);

    querySpy.mockRestore();
  });

  it('Reconcile_NoNewEvents_DoesNotHydrate', async () => {
    // Arrange: create state, append events, reconcile once, then reconcile again
    const eventStore = new EventStore(tmpDir);

    await initStateFile(tmpDir, 'noop-test', 'feature');

    await eventStore.append('noop-test', {
      type: 'workflow.started',
      data: { featureId: 'noop-test', workflowType: 'feature' },
    });

    // First reconcile applies events
    await reconcileFromEvents(tmpDir, 'noop-test', eventStore);

    // Act: Second reconcile with no new events
    const result = await reconcileFromEvents(tmpDir, 'noop-test', eventStore);

    // Assert: no reconciliation
    expect(result).toEqual({ reconciled: false, eventsApplied: 0 });
  });
});
