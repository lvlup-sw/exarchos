import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleReconcileState,
} from '../../../src/workflow/tools.js';
import { initStateFile, reconcileFromEvents } from '../../../src/workflow/state-store.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-state-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('handleReconcileState', () => {
  describe('Reconcile_WithStaleTaskState_PatchesFromEvents', () => {
    /** Reconcile folds a `workflow.started` and a `workflow.transition` event into the state file. */
    it('should reconcile stale state from events showing phase transition', async () => {
      const eventStore = new EventStore(tmpDir);

      await initStateFile(tmpDir, 'stale-test', 'feature');

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

      const result = await handleReconcileState(
        { featureId: 'stale-test' },
        tmpDir,
        eventStore,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        reconciled: true,
        eventsApplied: 2,
      });

      const stateFile = path.join(tmpDir, 'stale-test.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw.phase).toBe('plan');
    });
  });

  describe('Reconcile_WithEmptyEventStream_ReturnsNoChanges', () => {
    it('should return reconciled:false when no events exist', async () => {
      const eventStore = new EventStore(tmpDir);

      await initStateFile(tmpDir, 'empty-test', 'feature');

      const result = await handleReconcileState(
        { featureId: 'empty-test' },
        tmpDir,
        eventStore,
      );

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

      const result = await handleReconcileState(
        {} as { featureId: string },
        tmpDir,
        eventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INVALID_INPUT');
    });
  });

  describe('Reconcile_NoEventStore_ReturnsError', () => {
    it('should return error when no event store is configured', async () => {
      await initStateFile(tmpDir, 'no-store-test', 'feature');

      const result = await handleReconcileState(
        { featureId: 'no-store-test' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('EVENT_STORE_NOT_CONFIGURED');
    });
  });
});

describe('reconcileFromEvents_HydratesEvents', () => {
  it('Reconcile_WithTeamEvents_HydratesEventsIntoState', async () => {
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
      type: 'team.spawned' as import('../../../src/events/schemas.js').EventType,
      data: { featureId: 'hydrate-test', agentCount: 3 },
    });
    await eventStore.append('hydrate-test', {
      type: 'team.disbanded' as import('../../../src/events/schemas.js').EventType,
      data: { featureId: 'hydrate-test', totalDurationMs: 5000, tasksCompleted: 3, tasksFailed: 0 },
    });

    const result = await reconcileFromEvents(tmpDir, 'hydrate-test', eventStore);

    expect(result.reconciled).toBe(true);

    const stateFile = path.join(tmpDir, 'hydrate-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const events = raw._events as Array<Record<string, unknown>>;

    expect(events).toBeDefined();
    expect(events.length).toBeGreaterThanOrEqual(4);

    const teamSpawned = events.find((e) => e.type === 'team.spawned');
    const teamDisbanded = events.find((e) => e.type === 'team.disbanded');
    expect(teamSpawned).toBeDefined();
    expect(teamDisbanded).toBeDefined();
  });

  /** Each hydrated `_events` entry holds the event data fields at its top level. */
  it('Reconcile_WithModelEmittedEvents_PreservesAllDataFields', async () => {
    const eventStore = new EventStore(tmpDir);

    await initStateFile(tmpDir, 'data-test', 'feature');

    await eventStore.append('data-test', {
      type: 'workflow.started',
      data: { featureId: 'data-test', workflowType: 'feature' },
    });
    await eventStore.append('data-test', {
      type: 'team.disbanded' as import('../../../src/events/schemas.js').EventType,
      data: { totalDurationMs: 5000, tasksCompleted: 3, tasksFailed: 0 },
    });

    await reconcileFromEvents(tmpDir, 'data-test', eventStore);

    const stateFile = path.join(tmpDir, 'data-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const events = raw._events as Array<Record<string, unknown>>;

    const disbanded = events?.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    expect(disbanded!.totalDurationMs).toBe(5000);
    expect(disbanded!.tasksCompleted).toBe(3);
    expect(disbanded!.tasksFailed).toBe(0);
  });

  /**
   * The query spy lets the first call, which reads the events to fold, succeed.
   * Later calls fail, so the `_events` hydration fails, and reconcile still reports success.
   */
  it('Reconcile_EventStoreHydrationFails_WarnsButSucceeds', async () => {
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

    let callCount = 0;
    const originalQuery = eventStore.query.bind(eventStore);
    const querySpy = vi.spyOn(eventStore, 'query').mockImplementation(
      async (streamId, filters) => {
        callCount++;
        if (callCount <= 1) {
          return originalQuery(streamId, filters);
        }
        throw new Error('Hydration query failed');
      },
    );

    const result = await reconcileFromEvents(tmpDir, 'fail-hydrate', eventStore);

    expect(result.reconciled).toBe(true);
    expect(result.eventsApplied).toBeGreaterThanOrEqual(1);

    querySpy.mockRestore();
  });

  /** A second reconcile with no new events after the first one changes nothing. */
  it('Reconcile_NoNewEvents_DoesNotHydrate', async () => {
    const eventStore = new EventStore(tmpDir);

    await initStateFile(tmpDir, 'noop-test', 'feature');

    await eventStore.append('noop-test', {
      type: 'workflow.started',
      data: { featureId: 'noop-test', workflowType: 'feature' },
    });

    await reconcileFromEvents(tmpDir, 'noop-test', eventStore);

    const result = await reconcileFromEvents(tmpDir, 'noop-test', eventStore);

    expect(result).toEqual({ reconciled: false, eventsApplied: 0 });
  });

  /**
   * Reconcile deep-merges a `state.patched` artifacts patch into the state file.
   * Guards that read `state.artifacts`, such as `design-artifact-exists`, depend on this merge.
   */
  it('Reconcile_WithStatePatchedArtifacts_DeepMergesIntoState', async () => {
    const eventStore = new EventStore(tmpDir);
    await initStateFile(tmpDir, 'patch-test', 'feature');

    await eventStore.append('patch-test', {
      type: 'workflow.started',
      data: { featureId: 'patch-test', workflowType: 'feature' },
    });
    await eventStore.append('patch-test', {
      type: 'state.patched' as import('../../../src/events/schemas.js').EventType,
      data: {
        patch: {
          artifacts: {
            design: 'docs/designs/example.md',
            plan: 'docs/plans/example.md',
          },
        },
      },
    });

    const result = await reconcileFromEvents(tmpDir, 'patch-test', eventStore);
    expect(result.reconciled).toBe(true);

    const stateFile = path.join(tmpDir, 'patch-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    const artifacts = raw.artifacts as Record<string, unknown>;
    expect(artifacts.design).toBe('docs/designs/example.md');
    expect(artifacts.plan).toBe('docs/plans/example.md');
    expect(artifacts.pr).toBeNull();
  });

  it('Reconcile_WithStatePatchedNoPatchKey_IsNoOp', async () => {
    const eventStore = new EventStore(tmpDir);
    await initStateFile(tmpDir, 'no-patch-test', 'feature');

    await eventStore.append('no-patch-test', {
      type: 'workflow.started',
      data: { featureId: 'no-patch-test', workflowType: 'feature' },
    });
    await eventStore.append('no-patch-test', {
      type: 'state.patched' as import('../../../src/events/schemas.js').EventType,
      data: { artifacts: { design: 'wrong-shape.md' } },
    });

    await reconcileFromEvents(tmpDir, 'no-patch-test', eventStore);

    const stateFile = path.join(tmpDir, 'no-patch-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    const artifacts = raw.artifacts as Record<string, unknown>;
    expect(artifacts.design).toBeNull();
  });
});
