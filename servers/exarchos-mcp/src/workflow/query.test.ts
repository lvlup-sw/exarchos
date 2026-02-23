import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSummary, handleReconcile, handleTransitions, configureQueryEventStore } from './query.js';
import { configureStateStoreBackend } from './state-store.js';
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
    phase: 'ideate',
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
      phase: 'ideate',
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
    configureQueryEventStore(null);
  });

  it('handleSummary_ValidWorkflow_ReturnsProgressAndEvents', async () => {
    const state = makeBaseState({
      tasks: [
        { id: 't1', title: 'Task 1', status: 'complete', blockedBy: [] },
        { id: 't2', title: 'Task 2', status: 'pending', blockedBy: [] },
      ],
    });
    backend.setState('test-feature', state as never, 0);

    const mockEvents: WorkflowEvent[] = [
      {
        streamId: 'test-feature',
        sequence: 1,
        timestamp: NOW,
        type: 'workflow.started',
        schemaVersion: '1.0',
      },
    ];
    const mockStore = createMockEventStore(mockEvents);
    configureQueryEventStore(mockStore);

    const result = await handleSummary(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('test-feature');
    expect(data.phase).toBe('ideate');
    const progress = data.taskProgress as { completed: number; total: number };
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(2);
    expect((data.recentEvents as unknown[]).length).toBe(1);
  });

  it('handleSummary_NonExistentFeature_ReturnsError', async () => {
    const result = await handleSummary(
      { featureId: 'nonexistent' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(false);
    const error = result.error as { code: string; message: string };
    expect(error.code).toBe('STATE_NOT_FOUND');
    expect(error.message).toContain('nonexistent');
  });

  it('handleSummary_CompoundState_IncludesCircuitBreaker', async () => {
    // delegate is inside the 'implementation' compound in feature workflow
    const state = makeBaseState({ phase: 'delegate' });
    backend.setState('test-feature', state as never, 0);

    // Events with a compound-entry and a fix-cycle for the 'implementation' compound
    const mockEvents: WorkflowEvent[] = [
      {
        streamId: 'test-feature',
        sequence: 1,
        timestamp: NOW,
        type: 'workflow.compound-entry',
        schemaVersion: '1.0',
        data: { compoundStateId: 'implementation' },
      },
      {
        streamId: 'test-feature',
        sequence: 2,
        timestamp: NOW,
        type: 'workflow.fix-cycle',
        schemaVersion: '1.0',
        data: { compoundStateId: 'implementation' },
      },
    ];
    const mockStore = createMockEventStore(mockEvents);
    configureQueryEventStore(mockStore);

    const result = await handleSummary(
      { featureId: 'test-feature' },
      '/fake/state-dir',
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

    const state = makeBaseState({
      worktrees: {
        'wt-1': { branch: 'feat/task-1', taskId: 't1', status: 'active', path: worktreePath },
      },
    });
    backend.setState('test-feature', state as never, 0);

    const result = await handleReconcile(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const worktrees = data.worktrees as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].pathStatus).toBe('OK');
  });

  it('handleReconcile_MissingWorktree_ReportsInaccessible', async () => {
    const state = makeBaseState({
      worktrees: {
        'wt-1': { branch: 'feat/task-1', taskId: 't1', status: 'active', path: '/nonexistent/path/xyz' },
      },
    });
    backend.setState('test-feature', state as never, 0);

    const result = await handleReconcile(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const worktrees = data.worktrees as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].pathStatus).toBe('MISSING');
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
});

describe('handleTransitions', () => {
  it('handleTransitions_FeatureWorkflow_ReturnsAllTransitions', async () => {
    const result = await handleTransitions(
      { workflowType: 'feature' },
      '/fake/state-dir',
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
    expect(stateIds).toContain('ideate');
    expect(stateIds).toContain('completed');
  });

  it('handleTransitions_FilterByPhase_ReturnsSubset', async () => {
    const resultAll = await handleTransitions(
      { workflowType: 'feature' },
      '/fake/state-dir',
    );
    const resultFiltered = await handleTransitions(
      { workflowType: 'feature', fromPhase: 'review' },
      '/fake/state-dir',
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
