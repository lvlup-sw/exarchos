import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSummary, handleReconcile, handleTransitions } from './query.js';
import { configureStateStoreBackend } from './state-store.js';
import { handleGet } from './tools.js';
import { InMemoryBackend } from '../storage/memory-backend.js';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { QueryFilters } from '../event-store/store.js';

// ─── Minimal EventStore mock ──────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── Test Suite ────────────────────────────────────────────────────────────

describe('handleSummary', () => {
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend();
    configureStateStoreBackend(backend);
  });

  afterEach(() => {
    configureStateStoreBackend(undefined);
  });

  it('handleSummary_ValidWorkflow_ReturnsProgressAndEvents', async () => {
    // Event-sourced (#1504): seed the truth as the event log the projection
    // folds, not a decoupled backend snapshot.
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

  it('handleSummary_CompoundState_IncludesCircuitBreaker', async () => {
    // delegate is inside the 'implementation' compound in the feature workflow.
    // Event-sourced (#1504): the phase is folded from a workflow.transition,
    // not seeded into a decoupled backend snapshot.
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

  it('handleSummary_TruthInEventStoreNotBackend_FoldsTaskProgress', async () => {
    // Event-store-first (#1504): the event log is the sole source of truth.
    // Seed the truth ONLY in the event store — no backend.setState — and assert
    // handleSummary folds it. Under the legacy readStateFile path this fails
    // (the backend has no state → STATE_NOT_FOUND).
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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleReconcile_ValidWorktrees_ReportsAccessible', async () => {
    // Create a real directory to represent an accessible worktree path
    const worktreePath = path.join(tmpDir, 'wt-1');
    await fs.mkdir(worktreePath, { recursive: true });

    // Event-sourced (#1504): worktrees fold from a state.patched.
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
    expect(worktrees[0]!.pathStatus).toBe('OK');
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
    expect(worktrees[0]!.pathStatus).toBe('MISSING');
  });

  it('handleReconcile_NativeTaskDrift_ReportsDriftEntries', async () => {
    // Create native task dir with a task file whose status differs
    const nativeTaskDir = path.join(tmpDir, 'native-tasks', 'test-feature');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-t1.json'),
      JSON.stringify({ id: 'native-t1', subject: 'Task 1', status: 'completed' }),
    );

    // The state file on disk (raw) must contain nativeTaskId -- backend strips it via Zod
    // handleReconcile reads raw JSON from the state file for nativeTaskId.
    // Since we're using InMemoryBackend, reconcileTasks reads raw state via fs.readFile.
    // But for backend mode, it just does the worktree checks. Let's verify we can
    // test native task drift by writing a real state file instead.
    configureStateStoreBackend(undefined); // Switch to file-based

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
    // The task status 'pending' vs 'completed' should produce drift
    const driftEntry = drift.find(d => d.taskId === 't1');
    expect(driftEntry).toBeDefined();
    expect(driftEntry!.exarchosStatus).toBe('pending');
    expect(driftEntry!.nativeStatus).toBe('completed');
  });

  it('handleReconcile_TruthInEventStore_FoldsWorktreesAndNativeTaskId', async () => {
    // Event-store-first (#1504): worktrees + nativeTaskId fold from the log —
    // nativeTaskId rides a `tasks[0].nativeTaskId` state.patched (the array-index
    // fold fix). No backend.setState, no state file.
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
    expect(worktrees[0]!.pathStatus).toBe('OK');
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
    // Should include known phases
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
    // All filtered transitions should have from === 'review'
    for (const t of filteredTransitions) {
      expect(t.from).toBe('review');
    }
  });
});

// ─── T-14: Query filter edge cases ──────────────────────────────────────────

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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // (Removed HandleQuery_StateStoreNonNotFoundError_Rethrows: both handleSummary
  // and handleReconcile migrated to event-store-first (#1504) — neither reads the
  // backend directly, so the "rethrow a non-NOT_FOUND backend StateStoreError"
  // contract no longer applies to these handlers.)

  it('HandleQuery_WorktreePathFsAccessFails_ReportsPathMissing', async () => {
    // Create a path that will fail fs.access with a permission error (e.g., EACCES)
    // Using a non-existent deeply nested path triggers ENOENT which is caught as MISSING too
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
    // fs.access rejects for inaccessible paths -> status is MISSING
    expect(worktrees[0]!.pathStatus).toBe('MISSING');
  });

  // (Removed HandleQuery_RawStateJsonParseFailure_SkipsDriftGracefully:
  // handleReconcile no longer does a separate raw `.state.json` read for
  // nativeTaskId (#1504) — it reads tasks from the event fold — so the
  // "raw JSON parse fails → skip drift gracefully" failure mode is gone.
  // Native reconciliation now simply doesn't run when no folded task carries a
  // nativeTaskId.)

  it('HandleQuery_NativeTaskIdPresent_ReconcilesTaskDrift', async () => {
    // Switch to file-based mode so handleReconcile reads raw state with nativeTaskId
    configureStateStoreBackend(undefined);

    const stateDir = path.join(tmpDir, 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });

    // Create native task directory with a matching task
    const nativeTaskDir = path.join(tmpDir, 'native-tasks', 'test-feature');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'nt-1.json'),
      JSON.stringify({ id: 'nt-1', subject: 'Task 1', status: 'completed' }),
    );

    // State file with nativeTaskId on a task
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
    // in_progress vs completed should produce drift
    const entry = drift.find(d => d.taskId === 't1');
    expect(entry).toBeDefined();
    expect(entry!.exarchosStatus).toBe('in_progress');
    expect(entry!.nativeStatus).toBe('completed');
  });

  it('HandleQuery_NestedDotPathProjection_ReturnsCorrectFields', async () => {
    // Test field projection through handleGet (the query entry point for field projection)
    // handleGet calls projectState which resolves dot-path fields
    configureStateStoreBackend(undefined);

    const stateDir = path.join(tmpDir, 'workflow-state');
    await fs.mkdir(stateDir, { recursive: true });

    const stateData = makeBaseState({
      artifacts: { design: '/path/to/design.md', plan: '/path/to/plan.md', pr: null },
    });
    const stateFile = path.join(stateDir, 'test-feature.state.json');
    await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));

    // Request nested dot-path fields including an internal field
    const result = await handleGet(
      { featureId: 'test-feature', fields: ['artifacts.design', '_checkpoint.phase'] },
      stateDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // artifacts.design should be resolved
    expect(data['artifacts.design']).toBe('/path/to/design.md');
    // _checkpoint.phase should be filtered out (internal fields starting with _ are skipped)
    expect(data['_checkpoint.phase']).toBeUndefined();
  });
});
