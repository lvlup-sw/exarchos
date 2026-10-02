import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  applyDotPath,
  deepMerge,
  isPlainObject,
  readStateFile,
  writeStateFile,
  initStateFile,
  listStateFiles,
  configureStateStoreBackend,
  reconcileFromEvents,
  hydrateEventsFromStore,
  VersionConflictError,
  StateStoreError,
  TEMP_FILE_PATTERN,
  extractTempFilePid,
  nextTempPath,
  formatTempPath,
} from '../../../src/workflow/state-store.js';
import { spawn } from 'node:child_process';
import { isPidAlive } from '../../../src/utils/process.js';
import { EventStore } from '../../../src/events/store.js';
import { InMemoryBackend, VersionConflictError as BackendVersionConflictError } from '../../../src/storage/memory-backend.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import { readPublished } from '../../../src/utils/atomic-write.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('deepMerge', () => {
  it('DeepMerge_NestedObjects_MergesRecursively', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10, e: 5 } };

    const result = deepMerge(target, source);

    expect(result).toEqual({ a: { b: 10, c: 2, e: 5 }, d: 3 });
  });

  it('DeepMerge_ArrayValues_ReplacesNotMerges', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };

    const result = deepMerge(target, source);

    expect(result).toEqual({ items: [4, 5] });
  });

  /** `deepMerge` replaces an array as a whole and does no upsert by `id`. */
  it('DeepMerge_ArraysOfObjectsWithId_ReplacesEntirely', () => {
    const target = {
      tasks: [
        { id: 't1', status: 'complete' },
        { id: 't2', status: 'pending' },
        { id: 't3', status: 'pending' },
      ],
    };
    const source = {
      tasks: [
        { id: 'new-1', status: 'pending' },
        { id: 'new-2', status: 'pending' },
      ],
    };

    const result = deepMerge(target, source);

    expect(result.tasks).toEqual([
      { id: 'new-1', status: 'pending' },
      { id: 'new-2', status: 'pending' },
    ]);
  });

  it('DeepMerge_FlatObjects_MergesTopLevel', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };

    const result = deepMerge(target, source);

    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('DeepMerge_EmptySource_ReturnsTargetCopy', () => {
    const target = { a: 1, b: { c: 2 } };
    const source = {};

    const result = deepMerge(target, source);

    expect(result).toEqual({ a: 1, b: { c: 2 } });
    expect(result).not.toBe(target);
  });

  it('DeepMerge_DoesNotMutateOriginals', () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };

    deepMerge(target, source);

    expect(target).toEqual({ a: { b: 1 } });
    expect(source).toEqual({ a: { c: 2 } });
  });
});

describe('isPlainObject', () => {
  it('IsPlainObject_PlainObject_ReturnsTrue', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('IsPlainObject_EmptyObject_ReturnsTrue', () => {
    expect(isPlainObject({})).toBe(true);
  });

  it('IsPlainObject_Array_ReturnsFalse', () => {
    expect(isPlainObject([1, 2])).toBe(false);
  });

  it('IsPlainObject_Null_ReturnsFalse', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('IsPlainObject_String_ReturnsFalse', () => {
    expect(isPlainObject('hello')).toBe(false);
  });

  it('IsPlainObject_Number_ReturnsFalse', () => {
    expect(isPlainObject(42)).toBe(false);
  });

  it('IsPlainObject_Undefined_ReturnsFalse', () => {
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe('#1504 — backend-mode writers do not write .state.json', () => {
  let nwTmpDir: string;

  beforeEach(async () => {
    nwTmpDir = await mkdtemp(path.join(tmpdir(), 'statestore-nowrite-'));
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
    await rmrfAsync(nwTmpDir);
  });

  /** The backend is the authoritative store. A `.state.json` file can go stale and shadow the projection, so the store writes none. */
  it('initStateFile_BackendMode_DoesNotWriteStateJson', async () => {
    configureStateStoreBackend(new InMemoryBackend());

    const { stateFile } = await initStateFile(nwTmpDir, 'no-init-file', 'feature');

    await expect(fs.access(stateFile)).rejects.toThrow();
  });

  it('writeStateFile_BackendMode_DoesNotWriteStateJson', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);
    await initStateFile(nwTmpDir, 'no-write-file', 'feature');

    const stateFile = path.join(nwTmpDir, 'no-write-file.state.json');
    const state = backend.getState('no-write-file');
    expect(state).not.toBeNull();
    await writeStateFile(stateFile, { ...(state as WorkflowState), phase: 'plan' } as WorkflowState);

    expect(backend.getState('no-write-file')?.phase).toBe('plan');
    await expect(fs.access(stateFile)).rejects.toThrow();
  });

  /** Without a backend, the file is the only store, so the store must still write it. */
  it('initStateFile_NoBackend_StillWritesStateJson', async () => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);

    const { stateFile } = await initStateFile(nwTmpDir, 'degraded-init', 'feature');

    await expect(fs.access(stateFile)).resolves.toBeUndefined();
  });
});

describe('extractFeatureIdFromPath validation', () => {
  afterEach(() => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
  });

  /** The featureId `$(rm -rf)` holds shell metacharacters, so the read must fail as invalid input, not as not found. */
  it('extractFeatureIdFromPath_MaliciousPath_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const maliciousPath = '/some/dir/$(rm -rf).state.json';

    await expect(readStateFile(maliciousPath)).rejects.toThrow(/invalid featureId/i);
  });

  it('extractFeatureIdFromPath_ValidPath_Succeeds', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const state = {
      version: '1.1',
      featureId: 'my-feature',
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'ideate',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
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
        timestamp: new Date().toISOString(),
        phase: 'ideate',
        summary: 'Test',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: new Date().toISOString(),
        staleAfterMinutes: 120,
      },
    } as WorkflowState;
    backend.setState('my-feature', state);

    const validPath = '/some/dir/my-feature.state.json';
    const result = await readStateFile(validPath);
    expect(result.featureId).toBe('my-feature');
  });

  it('extractFeatureIdFromPath_PathWithSpaces_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const spacePath = '/some/dir/my feature.state.json';
    await expect(readStateFile(spacePath)).rejects.toThrow(/invalid featureId/i);
  });

  it('extractFeatureIdFromPath_PathWithShellChars_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const shellPath = '/some/dir/feat;echo pwned.state.json';
    await expect(readStateFile(shellPath)).rejects.toThrow(/invalid featureId/i);
  });

  it('extractFeatureIdFromPath_FeatureIdWithDotsAndUnderscores_Succeeds', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const state = {
      version: '1.1',
      featureId: 'my_feature.v2',
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'ideate',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
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
        timestamp: new Date().toISOString(),
        phase: 'ideate',
        summary: 'Test',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: new Date().toISOString(),
        staleAfterMinutes: 120,
      },
    } as WorkflowState;
    backend.setState('my_feature.v2', state);

    const validPath = '/some/dir/my_feature.v2.state.json';
    const result = await readStateFile(validPath);
    expect(result.featureId).toBe('my_feature.v2');
  });
});

describe('reconcileFromEvents query efficiency', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-query-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /** Reconcile queries the stream twice: once for the delta after `_eventSequence`, and once with no filter to hydrate `_events`. */
  it('reconcileFromEvents_WithDeltaEvents_QueriesStreamOnce', async () => {
    await initStateFile(tmpDir, 'query-test', 'feature');
    await eventStore.append('query-test', {
      type: 'workflow.started',
      data: { featureId: 'query-test', workflowType: 'feature' },
    });
    await eventStore.append('query-test', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'query-test' },
    });

    await reconcileFromEvents(tmpDir, 'query-test', eventStore);

    await eventStore.append('query-test', {
      type: 'workflow.transition',
      data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'query-test' },
    });

    const querySpy = vi.spyOn(eventStore, 'query');

    const result = await reconcileFromEvents(tmpDir, 'query-test', eventStore);

    expect(result.reconciled).toBe(true);
    expect(result.eventsApplied).toBe(1);

    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(querySpy).toHaveBeenCalledWith('query-test', { sinceSequence: 2 });
    expect(querySpy).toHaveBeenCalledWith('query-test');

    querySpy.mockRestore();
  });

  /** Reconcile takes the phase from the last transition in the delta, with no query beyond the delta and the hydration. */
  it('reconcileFromEvents_PhaseReconciliation_UsesLastTransitionFromDelta', async () => {
    await initStateFile(tmpDir, 'delta-phase', 'feature');
    await eventStore.append('delta-phase', {
      type: 'workflow.started',
      data: { featureId: 'delta-phase', workflowType: 'feature' },
    });
    await eventStore.append('delta-phase', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'delta-phase' },
    });

    await reconcileFromEvents(tmpDir, 'delta-phase', eventStore);

    await eventStore.append('delta-phase', {
      type: 'workflow.transition',
      data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'delta-phase' },
    });
    await eventStore.append('delta-phase', {
      type: 'workflow.checkpoint',
      data: { counter: 0, phase: 'delegate', featureId: 'delta-phase' },
    });

    const querySpy = vi.spyOn(eventStore, 'query');

    const result = await reconcileFromEvents(tmpDir, 'delta-phase', eventStore);

    expect(result.reconciled).toBe(true);

    const stateFile = path.join(tmpDir, 'delta-phase.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(raw.phase).toBe('delegate');

    expect(querySpy).toHaveBeenCalledTimes(2);

    querySpy.mockRestore();
  });

  /** The test sets `state._version` far above the backend version, so the CAS write conflicts. Reconcile must recover and write the state. */
  it('reconcileFromEvents_VersionConflict_RetriesAndSucceeds', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    await initStateFile(tmpDir, 'vc-test', 'feature');
    await eventStore.append('vc-test', {
      type: 'workflow.started',
      data: { featureId: 'vc-test', workflowType: 'feature' },
    });
    await eventStore.append('vc-test', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'vc-test' },
    });

    const currentState = backend.getState('vc-test')!;
    backend.setState('vc-test', { ...currentState, _version: 50 } as WorkflowState);

    const result = await reconcileFromEvents(tmpDir, 'vc-test', eventStore);

    expect(result.reconciled).toBe(true);
    expect(result.eventsApplied).toBeGreaterThanOrEqual(1);

    const state = await readStateFile(path.join(tmpDir, 'vc-test.state.json'));
    expect(state.phase).toBe('plan');

    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
  });
});

describe('State Store StorageBackend Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'state-store-backend-test-'));
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
    await rmrfAsync(tempDir);
  });

  function makeState(overrides?: Record<string, unknown>): WorkflowState {
    const now = new Date().toISOString();
    return {
      version: '1.1',
      featureId: 'test-feature',
      workflowType: 'feature',
      createdAt: now,
      updatedAt: now,
      phase: 'ideate',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
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
        timestamp: now,
        phase: 'ideate',
        summary: 'Test state',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: now,
        staleAfterMinutes: 120,
      },
      ...overrides,
    } as WorkflowState;
  }

  it('readStateFile_WithBackend_ReadsFromBackend', async () => {
    const backend = new InMemoryBackend();
    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    configureStateStoreBackend(backend);

    const stateFile = path.join(tempDir, 'my-feature.state.json');
    const result = await readStateFile(stateFile);

    expect(result.featureId).toBe('my-feature');
    expect(result.phase).toBe('ideate');
  });

  it('writeStateFile_WithBackend_WritesToBackend', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const state = makeState({ featureId: 'my-feature' });
    const stateFile = path.join(tempDir, 'my-feature.state.json');

    await writeStateFile(stateFile, state);

    const stored = backend.getState('my-feature');
    expect(stored).not.toBeNull();
    expect(stored!.featureId).toBe('my-feature');
  });

  it('writeStateFile_WithBackend_CASConflict_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const state = makeState({ featureId: 'my-feature' });

    backend.setState('my-feature', state);

    const stateFile = path.join(tempDir, 'my-feature.state.json');

    await expect(
      writeStateFile(stateFile, state, { expectedVersion: 99 }),
    ).rejects.toThrow(VersionConflictError);
  });

  it('initStateFile_WithBackend_InsertsIntoBackend', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const { state } = await initStateFile(tempDir, 'new-feature', 'feature');

    const stored = backend.getState('new-feature');
    expect(stored).not.toBeNull();
    expect(stored!.featureId).toBe('new-feature');
    expect(stored!.phase).toBe('plan');
  });

  it('listStateFiles_WithBackend_QueriesBackend', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    backend.setState('feature-a', makeState({ featureId: 'feature-a' }));
    backend.setState('feature-b', makeState({ featureId: 'feature-b' }));

    const result = await listStateFiles(tempDir);

    expect(result.valid).toHaveLength(2);
    expect(result.corrupt).toHaveLength(0);
    expect(result.valid.map(v => v.featureId).sort()).toEqual(['feature-a', 'feature-b']);
  });

  it('readStateFile_WithoutBackend_FallsBackToJSONFile', async () => {
    const { state, stateFile } = await initStateFile(tempDir, 'file-feature', 'feature');

    const result = await readStateFile(stateFile);
    expect(result.featureId).toBe('file-feature');
    expect(result.phase).toBe('plan');
  });

  it('readStateFile_WithBackend_StateNotFound_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const stateFile = path.join(tempDir, 'nonexistent.state.json');

    await expect(readStateFile(stateFile)).rejects.toThrow(StateStoreError);
  });
});

describe('State Store CAS Property Test', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'state-cas-property-test-'));
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
    await rmrfAsync(tempDir);
  });

  function makeState(overrides?: Record<string, unknown>): WorkflowState {
    const now = new Date().toISOString();
    return {
      version: '1.1',
      featureId: 'cas-test',
      workflowType: 'feature',
      createdAt: now,
      updatedAt: now,
      phase: 'ideate',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
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
        timestamp: now,
        phase: 'ideate',
        summary: 'CAS test',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: now,
        staleAfterMinutes: 120,
      },
      ...overrides,
    } as WorkflowState;
  }

  it('CAS_ConcurrentWrites_ExactlyOneSucceeds', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const state = makeState({ featureId: 'cas-test' });
    backend.setState('cas-test', state);

    const stateFile = path.join(tempDir, 'cas-test.state.json');

    const stateA = makeState({ featureId: 'cas-test', phase: 'plan' });
    const stateB = makeState({ featureId: 'cas-test', phase: 'delegate' });

    const results = await Promise.allSettled([
      writeStateFile(stateFile, stateA, { expectedVersion: 1 }),
      writeStateFile(stateFile, stateB, { expectedVersion: 1 }),
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const failedResult = failures[0] as PromiseRejectedResult;
    expect(failedResult.reason).toBeInstanceOf(VersionConflictError);
  });
});

describe('hydrateEventsFromStore', () => {
  it('HydrateEventsFromStore_EmptyEventStore_ReturnsEmptyArray', async () => {
    const mockEventStore = {
      query: vi.fn().mockResolvedValue([]),
    } as unknown as EventStore;

    const result = await hydrateEventsFromStore('test-feature', mockEventStore);

    expect(result).toEqual([]);
  });

  it('HydrateEventsFromStore_TransitionEvents_MapsTypeAndPreservesFields', async () => {
    const mockEventStore = {
      query: vi.fn().mockResolvedValue([
        {
          type: 'workflow.transition',
          timestamp: '2026-03-09T10:00:00.000Z',
          data: { from: 'ideate', to: 'plan', trigger: 'user' },
        },
      ]),
    } as unknown as EventStore;

    const result = await hydrateEventsFromStore('test-feature', mockEventStore);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('transition');
    expect(result[0].timestamp).toBe('2026-03-09T10:00:00.000Z');
    expect(result[0].from).toBe('ideate');
    expect(result[0].to).toBe('plan');
    expect(result[0].trigger).toBe('user');
    expect(result[0].metadata).toEqual({ from: 'ideate', to: 'plan', trigger: 'user' });
  });

  /** An unmapped type such as `team.spawned` stays unchanged. Every data field appears at the top level and in `metadata`. */
  it('HydrateEventsFromStore_TeamEvents_PreservesAllDataFields', async () => {
    const mockEventStore = {
      query: vi.fn().mockResolvedValue([
        {
          type: 'team.spawned',
          timestamp: '2026-03-09T10:00:00.000Z',
          data: { featureId: 'test-feature', agentCount: 3 },
        },
        {
          type: 'team.disbanded',
          timestamp: '2026-03-09T11:00:00.000Z',
          data: {
            featureId: 'test-feature',
            totalDurationMs: 5000,
            tasksCompleted: 3,
            tasksFailed: 0,
          },
        },
      ]),
    } as unknown as EventStore;

    const result = await hydrateEventsFromStore('test-feature', mockEventStore);

    expect(result).toHaveLength(2);

    expect(result[0].type).toBe('team.spawned');
    expect(result[0].featureId).toBe('test-feature');
    expect(result[0].agentCount).toBe(3);
    expect(result[0].metadata).toEqual({ featureId: 'test-feature', agentCount: 3 });

    expect(result[1].type).toBe('team.disbanded');
    expect(result[1].totalDurationMs).toBe(5000);
    expect(result[1].tasksCompleted).toBe(3);
    expect(result[1].tasksFailed).toBe(0);
    expect(result[1].metadata).toEqual({
      featureId: 'test-feature',
      totalDurationMs: 5000,
      tasksCompleted: 3,
      tasksFailed: 0,
    });
  });

  /**
   * `workflow.transition` maps to `transition`. The other types in this log have no mapping and stay unchanged.
   * Data fields go to the top level.
   */
  it('HydrateEventsFromStore_MixedEventTypes_MapsAllCorrectly', async () => {
    const mockEventStore = {
      query: vi.fn().mockResolvedValue([
        { type: 'workflow.started', timestamp: '2026-03-09T10:00:00.000Z', data: { featureId: 'test' } },
        { type: 'workflow.transition', timestamp: '2026-03-09T10:01:00.000Z', data: { from: 'ideate', to: 'plan' } },
        { type: 'team.spawned', timestamp: '2026-03-09T10:02:00.000Z', data: { featureId: 'test' } },
        { type: 'task.completed', timestamp: '2026-03-09T10:03:00.000Z', data: { taskId: 't1' } },
        { type: 'gate.executed', timestamp: '2026-03-09T10:04:00.000Z', data: { gateName: 'design', passed: true } },
        { type: 'team.disbanded', timestamp: '2026-03-09T10:05:00.000Z', data: { totalDurationMs: 5000 } },
      ]),
    } as unknown as EventStore;

    const result = await hydrateEventsFromStore('test-feature', mockEventStore);

    expect(result).toHaveLength(6);
    expect(result[0].type).toBe('workflow.started');
    expect(result[1].type).toBe('transition');
    expect(result[2].type).toBe('team.spawned');
    expect(result[3].type).toBe('task.completed');
    expect(result[4].type).toBe('gate.executed');
    expect(result[5].type).toBe('team.disbanded');

    expect(result[3].taskId).toBe('t1');
    expect(result[4].gateName).toBe('design');
    expect(result[5].totalDurationMs).toBe(5000);
  });

  it('HydrateEventsFromStore_EventStoreThrows_PropagatesError', async () => {
    const mockEventStore = {
      query: vi.fn().mockRejectedValue(new Error('Connection lost')),
    } as unknown as EventStore;

    await expect(
      hydrateEventsFromStore('test-feature', mockEventStore),
    ).rejects.toThrow('Connection lost');
  });
});

describe('applyDotPath array replacement (#1003)', () => {
  it('applyDotPath_tasksArrayWithNewIds_replacesEntireArray', () => {
    const obj: Record<string, unknown> = {
      tasks: [
        { id: 'task-1', title: 'Old Task 1', status: 'pending' },
        { id: 'task-2', title: 'Old Task 2', status: 'pending' },
        { id: 'task-3', title: 'Old Task 3', status: 'pending' },
      ],
    };

    applyDotPath(obj, 'tasks', [
      { id: 'taskA', title: 'New Task A', status: 'pending' },
      { id: 'taskB', title: 'New Task B', status: 'pending' },
    ]);

    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.id)).toEqual(['taskA', 'taskB']);
  });

  /** A plan revision replaces the task set, so no old task id remains. */
  it('applyDotPath_tasksArrayReplacement_staleTasksRemoved', () => {
    const obj: Record<string, unknown> = {
      tasks: [
        { id: '001', title: 'Old 1', status: 'complete' },
        { id: '002', title: 'Old 2', status: 'complete' },
        { id: '003', title: 'Old 3', status: 'pending' },
      ],
    };

    applyDotPath(obj, 'tasks', [
      { id: 'task-1', title: 'New 1', status: 'pending' },
      { id: 'task-2', title: 'New 2', status: 'pending' },
    ]);

    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => typeof t.id === 'string' && (t.id as string).startsWith('task-'))).toBe(true);
    expect(tasks.some(t => t.id === '001')).toBe(false);
  });
});

/**
 * `parsePath` accepts only numeric brackets, so keyed access such as `tasks[id=001]` throws.
 * A caller can replace the whole array, write one element by index, or append at index `arr.length`.
 * The append works because `assertArrayBounds` allows an index up to `arr.length + MAX_ARRAY_GAP`.
 * The checkpoint skill documents the append form.
 */
describe('applyDotPath array append syntax (T-17)', () => {
  it('workflowSetParser_ArrayInsertionSyntax_AppendsNewEntry', () => {
    const obj: Record<string, unknown> = {
      tasks: [
        { id: 'T-001', title: 'Existing 1', status: 'complete' },
        { id: 'T-002', title: 'Existing 2', status: 'in_progress' },
      ],
    };

    applyDotPath(obj, 'tasks[2]', {
      id: 'T-003',
      title: 'New follow-up',
      status: 'pending',
    });

    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual({ id: 'T-001', title: 'Existing 1', status: 'complete' });
    expect(tasks[1]).toEqual({ id: 'T-002', title: 'Existing 2', status: 'in_progress' });
    expect(tasks[2]).toEqual({ id: 'T-003', title: 'New follow-up', status: 'pending' });
  });

  /** A keyed form such as `tasks[id=abc]` must throw a clear error and change nothing. The by-index form still works. */
  it('workflowSetParser_ArrayInsertionSyntax_KeyedAccessFormThrowsClearError', () => {
    const obj: Record<string, unknown> = {
      tasks: [{ id: 'T-001', status: 'pending' }],
    };

    expect(() => applyDotPath(obj, 'tasks[id=T-001].status', 'complete')).toThrow(
      /keyed array access.*not supported/i,
    );

    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks[0].status).toBe('pending');
    expect(obj['tasks[id=T-001]']).toBeUndefined();

    applyDotPath(obj, 'tasks[0].status', 'complete');
    expect(tasks[0].status).toBe('complete');
  });

  /** The parser does not accept the compound form `tasks[0][1]`, so it must throw and not write a literal property name. */
  it('parsePath_CompoundBrackets_TasksZeroOne_ThrowsMalformedError', () => {
    const obj: Record<string, unknown> = { tasks: [['a', 'b']] };

    expect(() => applyDotPath(obj, 'tasks[0][1]', 'updated')).toThrow(
      /malformed array access/i,
    );
  });

  /** A keyed segment with no closing bracket does not match the keyed-access check. The malformed-access check must reject it. */
  it('parsePath_UnterminatedBracket_TasksKeyedNoClose_ThrowsMalformedError', () => {
    const obj: Record<string, unknown> = { tasks: [{ id: 'T-001' }] };

    expect(() =>
      applyDotPath(obj, 'tasks[id=T-001.status', 'complete'),
    ).toThrow(/malformed array access/i);
  });

  /** A bare `]` matches no bracket pattern and must fail as malformed access. */
  it('parsePath_MismatchedCloseBracket_TasksClose_ThrowsMalformedError', () => {
    const obj: Record<string, unknown> = { tasks: [] };

    expect(() => applyDotPath(obj, 'tasks].status', 'complete')).toThrow(
      /malformed array access/i,
    );
  });
});

/**
 * A `RESERVED_FIELD` rejection carries `data` with `rejectedPath`, `rule` and `alternateWritePath`.
 * A caller can use the alternate write path, such as `transition` for `phase`, without a parse of the message.
 */
describe('StateStoreError reserved-field data (#1360)', () => {
  it('StateStoreError_ReservedField_CarriesStructuredData', () => {
    const obj: Record<string, unknown> = { phase: 'plan' };

    try {
      applyDotPath(obj, 'phase', 'delegate');
      throw new Error('expected RESERVED_FIELD throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StateStoreError);
      const sse = err as StateStoreError;
      expect(sse.code).toBe('RESERVED_FIELD');
      expect(sse.data).toBeDefined();
      expect(sse.data?.rejectedPath).toBe('phase');
      expect(sse.data?.rule).toMatch(/immutable/i);
      expect(sse.data?.alternateWritePath).toMatch(/transition/i);
    }
  });

  /** A path that starts with `_` gets guidance that points at the event store. */
  it('StateStoreError_ReservedField_UnderscorePath_PopulatesGenericGuidance', () => {
    const obj: Record<string, unknown> = {};

    try {
      applyDotPath(obj, '_version', 99);
      throw new Error('expected RESERVED_FIELD throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StateStoreError);
      const sse = err as StateStoreError;
      expect(sse.code).toBe('RESERVED_FIELD');
      expect(sse.data?.rejectedPath).toBe('_version');
      expect(sse.data?.alternateWritePath).toMatch(/event/i);
    }
  });

  /**
   * `isReservedField` rejects a path with any segment that starts with `_`.
   * The alternate write path must match that inner segment too, not only the whole path.
   */
  it('ResolveAlternateWritePath_NestedUnderscoreSegment_ReturnsUnderscoreGuidance', () => {
    const obj: Record<string, unknown> = { foo: {} };

    try {
      applyDotPath(obj, 'foo._bar', 'x');
      throw new Error('expected RESERVED_FIELD throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StateStoreError);
      const sse = err as StateStoreError;
      expect(sse.code).toBe('RESERVED_FIELD');
      expect(sse.data?.rejectedPath).toBe('foo._bar');
      expect(sse.data?.alternateWritePath).toBeTruthy();
      expect(sse.data?.alternateWritePath).toMatch(/event/i);
    }
  });
});

/**
 * These tests pin two contracts together, because a fix to one can break the other.
 * Concurrent writers in one process must never get the same temp path.
 * The orphan sweep must read the writer pid from a temp filename, never the counter.
 * A counter read as a pid names a low, live pid, so the sweep never reaps the orphan.
 */
describe('temp-file naming and orphan sweep', () => {
  let tempDir: string;

  /** The file path is under test, and a configured backend skips it. */
  beforeEach(async () => {
    configureStateStoreBackend(undefined);
    tempDir = await mkdtemp(path.join(tmpdir(), 'statestore-tmpname-'));
  });

  /** `rmrfAsync` closes tracked SQLite handles under `tempDir` first, because Windows does not delete a file with an open handle. */
  afterEach(async () => {
    configureStateStoreBackend(undefined);
    await rmrfAsync(tempDir);
  });

  /** All writers target one state file. With a pid-only temp path, they share one temp file, overwrite each other, and a later rename fails with `ENOENT`. */
  it('WriteStateFile_ConcurrentInProcessWriters_NeverCollideOnTempPath', async () => {
    const { state, stateFile } = await initStateFile(tempDir, 'collide', 'feature');

    const writers = Array.from({ length: 24 }, (_, i) =>
      writeStateFile(stateFile, { ...state, _version: i } as WorkflowState, {
        skipValidation: true,
      }),
    );
    const results = await Promise.allSettled(writers);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);

    const leftovers = (await fs.readdir(tempDir)).filter((f) =>
      TEMP_FILE_PATTERN.test(f),
    );
    expect(leftovers).toEqual([]);

    const published = await fs.readFile(stateFile, 'utf-8');
    expect(() => JSON.parse(published)).not.toThrow();
  });

  /**
   * The payload is large, so `writeFile` takes more than one syscall. A shared temp path then publishes torn bytes.
   * The reader runs in this process and reads through the queue of the target, as the store reads do.
   * The reader also records `ENOENT`, so an unlink-then-rename publish fails the test.
   * A reader in another process is outside this test. On Windows, only the bounded publish retry covers it.
   */
  it('WriteStateFile_ConcurrentWriters_NeitherObservesPartialFile', async () => {
    const { state, stateFile } = await initStateFile(tempDir, 'partial', 'feature');

    const bulky = (marker: string): WorkflowState =>
      ({
        ...state,
        _version: 1,
        _padding: Array.from({ length: 4000 }, () => `${marker}-payload-chunk`),
      }) as unknown as WorkflowState;

    let readerStop = false;
    const readObservations: string[] = [];
    const reader = (async () => {
      while (!readerStop) {
        try {
          const raw = await readPublished(stateFile, () => fs.readFile(stateFile, 'utf-8'));
          JSON.parse(raw);
        } catch (err) {
          readObservations.push(String(err));
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    const writers = Array.from({ length: 12 }, (_, i) =>
      writeStateFile(stateFile, bulky(`w${i}`), { skipValidation: true }),
    );
    const results = await Promise.allSettled(writers);
    readerStop = true;
    await reader;

    expect(
      results
        .filter((r) => r.status === 'rejected')
        .map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);
    expect(readObservations).toEqual([]);

    const final = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(final.featureId).toBe('partial');
    expect(final._padding).toHaveLength(4000);
    const markers = new Set(
      (final._padding as string[]).map((c) => c.split('-')[0]),
    );
    expect(markers.size).toBe(1);
  });

  /**
   * The pid is the last segment of `.tmp.<counter>.<pid>`, so the end-anchored capture gets it.
   * A legacy `.tmp.<pid>` name must stay reapable, or an orphan from an older version leaks.
   * A name from `nextTempPath` must give back the pid of this process.
   */
  it('OrphanSweep_TempFileWithCounter_ExtractsPidNotCounter', () => {
    expect(extractTempFilePid('x.state.json.tmp.1.4242')).toBe(4242);
    expect(extractTempFilePid('x.state.json.tmp.99999.4242')).toBe(4242);
    expect(extractTempFilePid('x.state.json.init.7.4242')).toBe(4242);

    expect(extractTempFilePid('x.state.json.tmp.4242')).toBe(4242);
    expect(extractTempFilePid('x.state.json.init.4242')).toBe(4242);

    expect(extractTempFilePid('x.state.json')).toBeNull();
    expect(extractTempFilePid('x.state.json.tmp.abc')).toBeNull();
    expect(extractTempFilePid('notes.txt')).toBeNull();

    const emitted = nextTempPath(path.join(tempDir, 'agree.state.json'), 'tmp');
    expect(extractTempFilePid(emitted)).toBe(process.pid);
  });

  /**
   * A dead writer can leave a temp file with a counter equal to a live pid. The sweep must read the trailing pid and reap it.
   * A live writer with a dead-pid counter must keep its file. The names come from `formatTempPath`.
   * The decoy is the pid of this process. PID 1 can raise `EPERM` in a container, and `isPidAlive` reports that as not alive.
   */
  it('OrphanSweep_DeadPidWithLivePidCollidingCounter_StillReaps', async () => {
    const deadPid = await findDeadPid();
    const liveCounter = process.pid;
    expect(isPidAlive(deadPid)).toBe(false);
    expect(isPidAlive(liveCounter)).toBe(true);

    const deadOrphan = path.basename(
      formatTempPath('orphan-a.state.json', 'tmp', liveCounter, deadPid),
    );
    const deadInitOrphan = path.basename(
      formatTempPath('orphan-b.state.json', 'init', liveCounter, deadPid),
    );
    const liveOrphan = path.basename(
      formatTempPath('orphan-c.state.json', 'tmp', deadPid, liveCounter),
    );

    for (const f of [deadOrphan, deadInitOrphan, liveOrphan]) {
      await fs.writeFile(path.join(tempDir, f), '{}', 'utf-8');
    }

    await listStateFiles(tempDir);

    const remaining = await fs.readdir(tempDir);
    expect(remaining).not.toContain(deadOrphan);
    expect(remaining).not.toContain(deadInitOrphan);
    expect(remaining).toContain(liveOrphan);
  });
});

/**
 * Return the pid of a child process that has exited. A fixed high number can belong to a live process on a busy host.
 * The function waits 50 ms after `exit`, because the pid can stay a zombie for a short time.
 */
async function findDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise((r) => setTimeout(r, 50));
  return pid;
}
