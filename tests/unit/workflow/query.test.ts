import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSummary, handleReconcile, handleTransitions } from '../../../src/workflow/query.js';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.js';
import { handleGet } from '../../../src/workflow/tools.js';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';
import type { EventStore } from '../../../src/events/store.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { QueryFilters } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** Builds an EventStore stub whose `query` filters the given events by type and by sequence. */
function createMockEventStore(events: WorkflowEvent[] = []): EventStore {
  return {
    query: async (_streamId: string, filters?: QueryFilters): Promise<WorkflowEvent[]> => {
      let result = [...events];
      if (filters?.type) {
        result = result.filter(e => e.type === filters.type);
      }
      if (filters?.sinceSequence !== undefined) {
        result = result.filter(e => e.sequence > filters.sinceSequence!);
      }
      return result;
    },
    append: async () => events[0] ?? ({} as WorkflowEvent),
    batchAppend: async () => [],
    refreshSequence: async () => {},
    initialize: async () => {},
    setOutbox: () => {},
    listStreams: () => null,
  } as unknown as EventStore;
}

const NOW = '2026-01-15T12:00:00.000Z';

function makeBaseState(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    createdAt: NOW,
    updatedAt: NOW,
    phase: 'plan',
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: NOW,
      phase: 'plan',
      summary: 'Workflow initialized',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: NOW,
      staleAfterMinutes: 120,
    },
    ...overrides,
  };
}

describe('handleSummary', () => {
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend();
    configureStateStoreBackend(backend);
  });

  afterEach(() => {
    configureStateStoreBackend(undefined);
  });

  /** Seeds the event log that the projection folds, not a backend snapshot. */
  it('handleSummary_ValidWorkflow_ReturnsProgressAndEvents', async () => {
    const mockEvents: WorkflowEvent[] = [
      { streamId: 'test-feature', sequence: 1, timestamp: NOW, type: 'workflow.started', schemaVersion: '1.0', data: { featureId: 'test-feature', workflowType: 'feature' } },
      { streamId: 'test-feature', sequence: 2, timestamp: NOW, type: 'task.assigned', schemaVersion: '1.0', data: { taskId: 't1', title: 'Task 1' } },
      { streamId: 'test-feature', sequence: 3, timestamp: NOW, type: 'task.assigned', schemaVersion: '1.0', data: { taskId: 't2', title: 'Task 2' } },
      { streamId: 'test-feature', sequence: 4, timestamp: NOW, type: 'task.completed', schemaVersion: '1.0', data: { taskId: 't1' } },
    ];
    const mockStore = createMockEventStore(mockEvents);

    const result = await handleSummary(
      { featureId: 'test-feature' },
      '/fake/state-dir',
      mockStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('test-feature');
    expect(data.phase).toBe('plan');
    const progress = data.taskProgress as { completed: number; total: number };
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(2);
    expect((data.recentEvents as unknown[]).length).toBe(4);
  });

  it('handleSummary_NonExistentFeature_ReturnsError', async () => {
    const result = await handleSummary(
      { featureId: 'nonexistent' },
      '/fake/state-dir',
      null,
    );

    expect(result.success).toBe(false);
    const error = result.error as { code: string; message: string };
    expect(error.code).toBe('STATE_NOT_FOUND');
    expect(error.message).toContain('nonexistent');
  });

  /**
   * In the feature workflow, `delegate` is inside the `implementation` compound state.
   * The phase folds from a `workflow.transition` event.
   */
  it('handleSummary_CompoundState_IncludesCircuitBreaker', async () => {
    const mockEvents: WorkflowEvent[] = [
      {
        streamId: 'test-feature',
        sequence: 1,
        timestamp: NOW,
        type: 'workflow.started',
        schemaVersion: '1.0',
        data: { featureId: 'test-feature', workflowType: 'feature' },
      },
      {
        streamId: 'test-feature',
        sequence: 2,
        timestamp: NOW,
        type: 'workflow.transition',
        schemaVersion: '1.0',
        data: { to: 'delegate' },
      },
      {
        streamId: 'test-feature',
        sequence: 3,
        timestamp: NOW,
        type: 'workflow.compound-entry',
        schemaVersion: '1.0',
        data: { compoundStateId: 'implementation' },
      },
      {
        streamId: 'test-feature',
        sequence: 4,
        timestamp: NOW,
        type: 'workflow.fix-cycle',
        schemaVersion: '1.0',
        data: { compoundStateId: 'implementation' },
      },
    ];
    const mockStore = createMockEventStore(mockEvents);

    const result = await handleSummary(
      { featureId: 'test-feature' },
      '/fake/state-dir',
      mockStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const cb = data.circuitBreaker as Record<string, unknown>;
    expect(cb).toBeDefined();
    expect(cb.compoundId).toBe('implementation');
    expect(cb.fixCycleCount).toBe(1);
    expect(cb.maxFixCycles).toBe(3);
    expect(cb.open).toBe(false);
  });

  /** Seeds the events only in the event store, with no backend state, and asserts that handleSummary folds them. */
  it('handleSummary_TruthInEventStoreNotBackend_FoldsTaskProgress', async () => {
    const mockEvents: WorkflowEvent[] = [
      { streamId: 'es-feature', sequence: 1, timestamp: NOW, type: 'workflow.started', schemaVersion: '1.0', data: { featureId: 'es-feature', workflowType: 'feature' } },
      { streamId: 'es-feature', sequence: 2, timestamp: NOW, type: 'task.assigned', schemaVersion: '1.0', data: { taskId: 't1', title: 'Task 1' } },
      { streamId: 'es-feature', sequence: 3, timestamp: NOW, type: 'task.assigned', schemaVersion: '1.0', data: { taskId: 't2', title: 'Task 2' } },
      { streamId: 'es-feature', sequence: 4, timestamp: NOW, type: 'task.completed', schemaVersion: '1.0', data: { taskId: 't1' } },
    ];
    const mockStore = createMockEventStore(mockEvents);

    const result = await handleSummary({ featureId: 'es-feature' }, '/fake/state-dir', mockStore);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('es-feature');
    expect(data.workflowType).toBe('feature');
    const progress = data.taskProgress as { completed: number; total: number };
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(2);
  });
});

describe('handleReconcile', () => {
  let backend: InMemoryBackend;
  let tmpDir: string;

  beforeEach(async () => {
    backend = new InMemoryBackend();
    configureStateStoreBackend(backend);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-query-test-'));
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined);
    await rmrfAsync(tmpDir);
  });

  /** The worktree folds from a `state.patched` event, and its path is a real directory. */
  it('handleReconcile_ValidWorktrees_ReportsAccessible', async () => {
    const worktreePath = path.join(tmpDir, 'wt-1');
    await fs.mkdir(worktreePath, { recursive: true });

    const mockStore = createMockEventStore([
      { streamId: 'test-feature', sequence: 1, timestamp: NOW, type: 'workflow.started', schemaVersion: '1.0', data: { featureId: 'test-feature', workflowType: 'feature' } },
      { streamId: 'test-feature', sequence: 2, timestamp: NOW, type: 'state.patched', schemaVersion: '1.0', data: { patch: { 'worktrees.wt-1': { branch: 'feat/task-1', taskId: 't1', status: 'active', path: worktreePath } } } },
    ]);

    const result = await handleReconcile(
      { featureId: 'test-feature' },
      '/fake/state-dir',
      mockStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const worktrees = data.worktrees as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].pathStatus).toBe('OK');
  });

  it('handleReconcile_MissingWorktree_ReportsInaccessible', async () => {
    const mockStore = createMockEventStore([
      { streamId: 'test-feature', sequence: 1, timestamp: NOW, type: 'workflow.started', schemaVersion: '1.0', data: { featureId: 'test-feature', workflowType: 'feature' } },
      { streamId: 'test-feature', sequence: 2, timestamp: NOW, type: 'state.patched', schemaVersion: '1.0', data: { patch: { 'worktrees.wt-1': { branch: 'feat/task-1', taskId: 't1', status: 'active', path: '/nonexistent/path/xyz' } } } },
    ]);

    const result = await handleReconcile(
      { featureId: 'test-feature' },
      '/fake/state-dir',
      mockStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const worktrees = data.worktrees as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].pathStatus).toBe('MISSING');
  });

  /**
   * The test removes the backend and passes no event store, so handleReconcile reads the state file on disk.
   * That file carries the `nativeTaskId` of the task.
   */
  it('handleReconcile_NativeTaskDrift_ReportsDriftEntries', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks', 'test-feature');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-t1.json'),
      JSON.stringify({ id: 'native-t1', subject: 'Task 1', status: 'completed' }),
    );

    configureStateStoreBackend(undefined);

    const stateDir = path.join(tmpDir, 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });

    const stateData = makeBaseState({
      tasks: [
        { id: 't1', title: 'Task 1', status: 'pending', nativeTaskId: 'native-t1', blockedBy: [] },
      ],
      worktrees: {},
    });
    const stateFile = path.join(stateDir, 'test-feature.state.json');
    await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));

    const nativeBaseDir = path.join(tmpDir, 'native-tasks');
    const result = await handleReconcile(
      { featureId: 'test-feature' },
      stateDir,
      null,
      nativeBaseDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const taskDrift = data.taskDrift as Record<string, unknown>;
    expect(taskDrift).toBeDefined();
    expect(taskDrift.skipped).toBe(false);
    const drift = taskDrift.drift as Array<Record<string, unknown>>;
    expect(drift.length).toBeGreaterThan(0);
    const driftEntry = drift.find(d => d.taskId === 't1');
    expect(driftEntry).toBeDefined();
    expect(driftEntry!.exarchosStatus).toBe('pending');
    expect(driftEntry!.nativeStatus).toBe('completed');
  });

  /**
   * Worktrees and `nativeTaskId` fold from the event log, with no backend state and no state file.
   * A `state.patched` event on the `tasks[0].nativeTaskId` path carries the native task id.
   */
  it('handleReconcile_TruthInEventStore_FoldsWorktreesAndNativeTaskId', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks', 'es-feature');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'nt-9.json'),
      JSON.stringify({ id: 'nt-9', subject: 'Task 1', status: 'completed' }),
    );
    const wtPath = path.join(tmpDir, 'wt-es');
    await fs.mkdir(wtPath, { recursive: true });

    const mockEvents: WorkflowEvent[] = [
      { streamId: 'es-feature', sequence: 1, timestamp: NOW, type: 'workflow.started', schemaVersion: '1.0', data: { featureId: 'es-feature', workflowType: 'feature' } },
      { streamId: 'es-feature', sequence: 2, timestamp: NOW, type: 'task.assigned', schemaVersion: '1.0', data: { taskId: 't1', title: 'Task 1' } },
      { streamId: 'es-feature', sequence: 3, timestamp: NOW, type: 'state.patched', schemaVersion: '1.0', data: { patch: { 'tasks[0].nativeTaskId': 'nt-9', 'worktrees.wt-1': { branch: 'feat/1', taskId: 't1', status: 'active', path: wtPath } } } },
    ];
    const mockStore = createMockEventStore(mockEvents);

    const result = await handleReconcile(
      { featureId: 'es-feature' },
      '/fake/state-dir',
      mockStore,
      path.join(tmpDir, 'native-tasks'),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const worktrees = data.worktrees as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].pathStatus).toBe('OK');
    const taskDrift = data.taskDrift as Record<string, unknown>;
    expect(taskDrift).toBeDefined();
    const drift = taskDrift.drift as Array<Record<string, unknown>>;
    const entry = drift.find((d) => d.taskId === 't1');
    expect(entry).toBeDefined();
    expect(entry!.exarchosStatus).toBe('pending');
    expect(entry!.nativeStatus).toBe('completed');
  });
});

describe('handleTransitions', () => {
  it('handleTransitions_FeatureWorkflow_ReturnsAllTransitions', async () => {
    const result = await handleTransitions(
      { workflowType: 'feature' },
      '/fake/state-dir',
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.workflowType).toBe('feature');
    const transitions = data.transitions as Array<Record<string, unknown>>;
    expect(transitions.length).toBeGreaterThan(0);
    const states = data.states as Array<Record<string, unknown>>;
    expect(states.length).toBeGreaterThan(0);
    const stateIds = states.map(s => s.id);
    expect(stateIds).toContain('plan');
    expect(stateIds).toContain('completed');
  });

  it('handleTransitions_FilterByPhase_ReturnsSubset', async () => {
    const resultAll = await handleTransitions(
      { workflowType: 'feature' },
      '/fake/state-dir',
      null,
    );
    const resultFiltered = await handleTransitions(
      { workflowType: 'feature', fromPhase: 'review' },
      '/fake/state-dir',
      null,
    );

    const allTransitions = (resultAll.data as Record<string, unknown>).transitions as unknown[];
    const filteredTransitions = (resultFiltered.data as Record<string, unknown>).transitions as Array<Record<string, unknown>>;

    expect(filteredTransitions.length).toBeGreaterThan(0);
    expect(filteredTransitions.length).toBeLessThan(allTransitions.length);
    for (const t of filteredTransitions) {
      expect(t.from).toBe('review');
    }
  });
});

describe('HandleQuery edge cases', () => {
  let backend: InMemoryBackend;
  let tmpDir: string;

  beforeEach(async () => {
    backend = new InMemoryBackend();
    configureStateStoreBackend(backend);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-query-edge-'));
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined);
    await rmrfAsync(tmpDir);
  });

  /** A nested path that does not exist makes `fs.access` reject, so the path status is MISSING. */
  it('HandleQuery_WorktreePathFsAccessFails_ReportsPathMissing', async () => {
    const inaccessiblePath = path.join(tmpDir, 'no-perms', 'deeply', 'nested', 'nonexistent');

    const mockStore = createMockEventStore([
      { streamId: 'test-feature', sequence: 1, timestamp: NOW, type: 'workflow.started', schemaVersion: '1.0', data: { featureId: 'test-feature', workflowType: 'feature' } },
      { streamId: 'test-feature', sequence: 2, timestamp: NOW, type: 'state.patched', schemaVersion: '1.0', data: { patch: { 'worktrees.wt-1': { branch: 'feat/task-1', taskId: 't1', status: 'active', path: inaccessiblePath } } } },
    ]);

    const result = await handleReconcile(
      { featureId: 'test-feature' },
      '/fake/state-dir',
      mockStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const worktrees = data.worktrees as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].pathStatus).toBe('MISSING');
  });

  /** With no backend and no event store, handleReconcile reads the state file that carries the `nativeTaskId`. */
  it('HandleQuery_NativeTaskIdPresent_ReconcilesTaskDrift', async () => {
    configureStateStoreBackend(undefined);

    const stateDir = path.join(tmpDir, 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });

    const nativeTaskDir = path.join(tmpDir, 'native-tasks', 'test-feature');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'nt-1.json'),
      JSON.stringify({ id: 'nt-1', subject: 'Task 1', status: 'completed' }),
    );

    const stateData = makeBaseState({
      tasks: [
        { id: 't1', title: 'Task 1', status: 'in_progress', nativeTaskId: 'nt-1', blockedBy: [] },
      ],
      worktrees: {},
    });
    const stateFile = path.join(stateDir, 'test-feature.state.json');
    await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));

    const nativeBaseDir = path.join(tmpDir, 'native-tasks');
    const result = await handleReconcile(
      { featureId: 'test-feature' },
      stateDir,
      null,
      nativeBaseDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const taskDrift = data.taskDrift as Record<string, unknown>;
    expect(taskDrift).toBeDefined();
    expect(taskDrift.skipped).toBe(false);
    const drift = taskDrift.drift as Array<Record<string, unknown>>;
    expect(drift.length).toBeGreaterThan(0);
    const entry = drift.find(d => d.taskId === 't1');
    expect(entry).toBeDefined();
    expect(entry!.exarchosStatus).toBe('in_progress');
    expect(entry!.nativeStatus).toBe('completed');
  });

  /** handleGet resolves dot-path fields and skips a path that has a segment that starts with an underscore. */
  it('HandleQuery_NestedDotPathProjection_ReturnsCorrectFields', async () => {
    configureStateStoreBackend(undefined);

    const stateDir = path.join(tmpDir, 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });

    const stateData = makeBaseState({
      artifacts: { design: '/path/to/design.md', plan: '/path/to/plan.md', pr: null },
    });
    const stateFile = path.join(stateDir, 'test-feature.state.json');
    await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));

    const result = await handleGet(
      { featureId: 'test-feature', fields: ['artifacts.design', '_checkpoint.phase'] },
      stateDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['artifacts.design']).toBe('/path/to/design.md');
    expect(data['_checkpoint.phase']).toBeUndefined();
  });
});
