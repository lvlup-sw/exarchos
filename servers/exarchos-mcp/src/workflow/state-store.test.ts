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
} from './state-store.js';
import { EventStore } from '../event-store/store.js';
import { InMemoryBackend, VersionConflictError as BackendVersionConflictError } from '../storage/memory-backend.js';
import type { WorkflowState } from './types.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

  it('DeepMerge_ArraysOfObjectsWithId_ReplacesEntirely', () => {
    // Arrays are replaced entirely — no id-based upsert (#1003)
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

    // Full replacement: only incoming entries remain
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

// ─── #1504: backend-mode writers do not write .state.json ─────────────────

describe('#1504 — backend-mode writers do not write .state.json', () => {
  let nwTmpDir: string;

  beforeEach(async () => {
    nwTmpDir = await mkdtemp(path.join(tmpdir(), 'statestore-nowrite-'));
  });

  afterEach(async () => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
    await rmrfAsync(nwTmpDir);
  });

  it('initStateFile_BackendMode_DoesNotWriteStateJson', async () => {
    configureStateStoreBackend(new InMemoryBackend());

    const { stateFile } = await initStateFile(nwTmpDir, 'no-init-file', 'feature');

    // Backend is the authoritative store (#1504); no `.state.json` crash-backup
    // is written so the file can never go stale or shadow the projection.
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

    // The mutation landed in the backend, not on disk.
    expect(backend.getState('no-write-file')?.phase).toBe('plan');
    await expect(fs.access(stateFile)).rejects.toThrow();
  });

  it('initStateFile_NoBackend_StillWritesStateJson', async () => {
    // Degradation path (CLI/legacy, no backend): the file remains the only
    // store, so it must still be written.
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);

    const { stateFile } = await initStateFile(nwTmpDir, 'degraded-init', 'feature');

    await expect(fs.access(stateFile)).resolves.toBeUndefined();
  });
});

// ─── Issue 4: extractFeatureIdFromPath Validation ─────────────────────────

describe('extractFeatureIdFromPath validation', () => {
  afterEach(() => {
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
  });

  it('extractFeatureIdFromPath_MaliciousPath_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    // basename of this is "$(rm -rf).state.json" -> featureId "$(rm -rf)"
    // The extracted featureId contains shell metacharacters and should be rejected
    // with INVALID_INPUT, not STATE_NOT_FOUND
    const maliciousPath = '/some/dir/$(rm -rf).state.json';

    await expect(readStateFile(maliciousPath)).rejects.toThrow(/invalid featureId/i);
  });

  it('extractFeatureIdFromPath_ValidPath_Succeeds', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    // Normal feature ID with allowed characters
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

    // basename of "feat;echo pwned.state.json" produces featureId "feat;echo pwned"
    // which contains shell metacharacters
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

// ─── reconcileFromEvents Query Efficiency ─────────────────────────────────

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

  it('reconcileFromEvents_WithDeltaEvents_QueriesStreamOnce', async () => {
    // Arrange: create state file and append events so we have a delta path
    await initStateFile(tmpDir, 'query-test', 'feature');
    await eventStore.append('query-test', {
      type: 'workflow.started',
      data: { featureId: 'query-test', workflowType: 'feature' },
    });
    await eventStore.append('query-test', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'query-test' },
    });

    // First reconciliation to establish _eventSequence
    await reconcileFromEvents(tmpDir, 'query-test', eventStore);

    // Append a new transition event to create delta work
    await eventStore.append('query-test', {
      type: 'workflow.transition',
      data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'query-test' },
    });

    // Spy on eventStore.query
    const querySpy = vi.spyOn(eventStore, 'query');

    // Act: reconcile with delta events
    const result = await reconcileFromEvents(tmpDir, 'query-test', eventStore);

    // Assert: reconciliation happened
    expect(result.reconciled).toBe(true);
    expect(result.eventsApplied).toBe(1);

    // Assert: eventStore.query called twice: once for delta events, once for _events hydration
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(querySpy).toHaveBeenCalledWith('query-test', { sinceSequence: 2 });
    // Second call is hydration (full query, no filters)
    expect(querySpy).toHaveBeenCalledWith('query-test');

    querySpy.mockRestore();
  });

  it('reconcileFromEvents_PhaseReconciliation_UsesLastTransitionFromDelta', async () => {
    // Arrange: create state and do initial reconciliation
    await initStateFile(tmpDir, 'delta-phase', 'feature');
    await eventStore.append('delta-phase', {
      type: 'workflow.started',
      data: { featureId: 'delta-phase', workflowType: 'feature' },
    });
    await eventStore.append('delta-phase', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'delta-phase' },
    });

    // First reconciliation
    await reconcileFromEvents(tmpDir, 'delta-phase', eventStore);

    // Append multiple events including transitions in the delta
    await eventStore.append('delta-phase', {
      type: 'workflow.transition',
      data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'delta-phase' },
    });
    await eventStore.append('delta-phase', {
      type: 'workflow.checkpoint',
      data: { counter: 0, phase: 'delegate', featureId: 'delta-phase' },
    });

    // Spy on eventStore.query to verify no redundant full-stream read
    const querySpy = vi.spyOn(eventStore, 'query');

    // Act
    const result = await reconcileFromEvents(tmpDir, 'delta-phase', eventStore);

    // Assert: phase is correct from delta events, no full-stream re-read needed
    expect(result.reconciled).toBe(true);

    const stateFile = path.join(tmpDir, 'delta-phase.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(raw.phase).toBe('delegate');

    // Delta query + hydration query = 2 calls
    expect(querySpy).toHaveBeenCalledTimes(2);

    querySpy.mockRestore();
  });

  it('reconcileFromEvents_VersionConflict_RetriesAndSucceeds', async () => {
    // Arrange: configure backend and create state
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

    // Desync the backend version: manually set backend version much lower
    // than state._version by re-seeding with a low-version state
    const currentState = backend.getState('vc-test')!;
    backend.setState('vc-test', { ...currentState, _version: 50 } as WorkflowState);
    // Backend version is now 2 (initial seed + one setState), but state._version is 50

    // Act: reconcile should handle the VERSION_CONFLICT internally
    const result = await reconcileFromEvents(tmpDir, 'vc-test', eventStore);

    // Assert: reconciliation succeeded despite version desync
    expect(result.reconciled).toBe(true);
    expect(result.eventsApplied).toBeGreaterThanOrEqual(1);

    // Verify the state was actually written
    const state = await readStateFile(path.join(tmpDir, 'vc-test.state.json'));
    expect(state.phase).toBe('plan');

    // Cleanup
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
  });
});

// ─── Task 16: State Store StorageBackend Integration ─────────────────────────

describe('State Store StorageBackend Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'state-store-backend-test-'));
  });

  afterEach(async () => {
    // Reset module-level backend to null after each test
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
    await rmrfAsync(tempDir);
  });

  // Helper to create a minimal valid WorkflowState for testing
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

    // Verify state was written to backend
    const stored = backend.getState('my-feature');
    expect(stored).not.toBeNull();
    expect(stored!.featureId).toBe('my-feature');
  });

  it('writeStateFile_WithBackend_CASConflict_Throws', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const state = makeState({ featureId: 'my-feature' });

    // Write initial state (creates version 1 in backend)
    backend.setState('my-feature', state);

    const stateFile = path.join(tempDir, 'my-feature.state.json');

    // Write with wrong expectedVersion — should throw
    await expect(
      writeStateFile(stateFile, state, { expectedVersion: 99 }),
    ).rejects.toThrow(VersionConflictError);
  });

  it('initStateFile_WithBackend_InsertsIntoBackend', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    const { state } = await initStateFile(tempDir, 'new-feature', 'feature');

    // Verify the state was saved into the backend
    const stored = backend.getState('new-feature');
    expect(stored).not.toBeNull();
    expect(stored!.featureId).toBe('new-feature');
    expect(stored!.phase).toBe('plan');
  });

  it('listStateFiles_WithBackend_QueriesBackend', async () => {
    const backend = new InMemoryBackend();
    configureStateStoreBackend(backend);

    // Add two states to the backend
    backend.setState('feature-a', makeState({ featureId: 'feature-a' }));
    backend.setState('feature-b', makeState({ featureId: 'feature-b' }));

    const result = await listStateFiles(tempDir);

    expect(result.valid).toHaveLength(2);
    expect(result.corrupt).toHaveLength(0);
    expect(result.valid.map(v => v.featureId).sort()).toEqual(['feature-a', 'feature-b']);
  });

  it('readStateFile_WithoutBackend_FallsBackToJSONFile', async () => {
    // No backend configured — use file path
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

// ─── Task 16: Property Tests for CAS ─────────────────────────────────────────

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

    // Seed the backend with initial state (version 1)
    const state = makeState({ featureId: 'cas-test' });
    backend.setState('cas-test', state);

    const stateFile = path.join(tempDir, 'cas-test.state.json');

    // Both writers read version 1 and try to write with expectedVersion=1
    const stateA = makeState({ featureId: 'cas-test', phase: 'plan' });
    const stateB = makeState({ featureId: 'cas-test', phase: 'delegate' });

    const results = await Promise.allSettled([
      writeStateFile(stateFile, stateA, { expectedVersion: 1 }),
      writeStateFile(stateFile, stateB, { expectedVersion: 1 }),
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    // Exactly one should succeed and one should fail
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // The failure should be a VersionConflictError
    const failedResult = failures[0] as PromiseRejectedResult;
    expect(failedResult.reason).toBeInstanceOf(VersionConflictError);
  });
});

// Write-through `.state.json` backup removed (#1504): the backend is the sole
// authoritative store in backend mode. The no-write contract is pinned by the
// `#1504 — backend-mode writers do not write .state.json` block above.

// ─── hydrateEventsFromStore ──────────────────────────────────────────────────

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
    expect(result[0].type).toBe('transition'); // mapped via mapExternalToInternalType
    expect(result[0].timestamp).toBe('2026-03-09T10:00:00.000Z');
    expect(result[0].from).toBe('ideate');
    expect(result[0].to).toBe('plan');
    expect(result[0].trigger).toBe('user');
    expect(result[0].metadata).toEqual({ from: 'ideate', to: 'plan', trigger: 'user' });
  });

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

    // team.spawned: type is NOT mapped (no workflow. prefix)
    expect(result[0].type).toBe('team.spawned');
    expect(result[0].featureId).toBe('test-feature');
    expect(result[0].agentCount).toBe(3);
    expect(result[0].metadata).toEqual({ featureId: 'test-feature', agentCount: 3 });

    // team.disbanded: ALL data fields at top level AND in metadata
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
    // workflow.started maps via mapExternalToInternalType (no explicit mapping, returns 'workflow.started')
    expect(result[0].type).toBe('workflow.started');
    // workflow.transition maps to 'transition'
    expect(result[1].type).toBe('transition');
    // team.spawned stays as-is
    expect(result[2].type).toBe('team.spawned');
    // task.completed stays as-is
    expect(result[3].type).toBe('task.completed');
    // gate.executed stays as-is
    expect(result[4].type).toBe('gate.executed');
    // team.disbanded stays as-is
    expect(result[5].type).toBe('team.disbanded');

    // Each event has its data fields at top level
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

// ─── Issue #1003: applyDotPath array replacement regression ──────────────────

describe('applyDotPath array replacement (#1003)', () => {
  it('applyDotPath_tasksArrayWithNewIds_replacesEntireArray', () => {
    // Arrange
    const obj: Record<string, unknown> = {
      tasks: [
        { id: 'task-1', title: 'Old Task 1', status: 'pending' },
        { id: 'task-2', title: 'Old Task 2', status: 'pending' },
        { id: 'task-3', title: 'Old Task 3', status: 'pending' },
      ],
    };

    // Act
    applyDotPath(obj, 'tasks', [
      { id: 'taskA', title: 'New Task A', status: 'pending' },
      { id: 'taskB', title: 'New Task B', status: 'pending' },
    ]);

    // Assert
    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.id)).toEqual(['taskA', 'taskB']);
  });

  it('applyDotPath_tasksArrayReplacement_staleTasksRemoved', () => {
    // Arrange - simulate plan revision scenario from issue #1003
    const obj: Record<string, unknown> = {
      tasks: [
        { id: '001', title: 'Old 1', status: 'complete' },
        { id: '002', title: 'Old 2', status: 'complete' },
        { id: '003', title: 'Old 3', status: 'pending' },
      ],
    };

    // Act - replace with entirely new task set
    applyDotPath(obj, 'tasks', [
      { id: 'task-1', title: 'New 1', status: 'pending' },
      { id: 'task-2', title: 'New 2', status: 'pending' },
    ]);

    // Assert
    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => typeof t.id === 'string' && (t.id as string).startsWith('task-'))).toBe(true);
    // Old IDs must not exist
    expect(tasks.some(t => t.id === '001')).toBe(false);
  });
});

// ─── T-17 (DR-8c): documented array-insertion syntax in workflow_set ─────────
//
// `skills-src/checkpoint/SKILL.md` previously documented `tasks[id=001]`
// as the pattern for editing a single task in place. The parser does NOT
// support keyed array access — `parsePath` only recognizes numeric brackets
// (`[\d+]`). The supported insertion patterns are:
//   1. Replace the entire array: `updates: { tasks: [...] }`
//   2. Replace one element by index: `updates: { 'tasks[0].status': '...' }`
//   3. Append by next index: `updates: { 'tasks[<length>]': { id, title } }`
//      — `assertArrayBounds` allows `index <= arr.length + MAX_ARRAY_GAP` so
//      writing at the current `arr.length` slot performs a real append.
//
// This test pins option (3) so the SKILL.md worked example can rely on it.
describe('applyDotPath array append syntax (T-17)', () => {
  it('workflowSetParser_ArrayInsertionSyntax_AppendsNewEntry', () => {
    // Arrange — start with a 2-element task array, mimicking a workflow that
    // already received its first plan and now wants to add a follow-up task
    // without rewriting the whole list.
    const obj: Record<string, unknown> = {
      tasks: [
        { id: 'T-001', title: 'Existing 1', status: 'complete' },
        { id: 'T-002', title: 'Existing 2', status: 'in_progress' },
      ],
    };

    // Act — append by writing at index === current array length.
    // This is the syntax `skills-src/checkpoint/SKILL.md` documents.
    applyDotPath(obj, 'tasks[2]', {
      id: 'T-003',
      title: 'New follow-up',
      status: 'pending',
    });

    // Assert — array grew by exactly one entry; existing entries unchanged.
    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual({ id: 'T-001', title: 'Existing 1', status: 'complete' });
    expect(tasks[1]).toEqual({ id: 'T-002', title: 'Existing 2', status: 'in_progress' });
    expect(tasks[2]).toEqual({ id: 'T-003', title: 'New follow-up', status: 'pending' });
  });

  it('workflowSetParser_ArrayInsertionSyntax_KeyedAccessFormThrowsClearError', () => {
    // fix-004 (review #1213, T-17c): the keyed-access form `tasks[id=T-001]`
    // used to be silently misapplied (parser fell through to a literal
    // property name and created a bogus top-level key). That was the worst
    // possible failure mode — caller saw `success: true` while the actual
    // task was untouched. The parser now throws a clear error so callers
    // get loud feedback and can switch to the by-index form documented in
    // skills-src/checkpoint/SKILL.md.
    const obj: Record<string, unknown> = {
      tasks: [{ id: 'T-001', status: 'pending' }],
    };

    expect(() => applyDotPath(obj, 'tasks[id=T-001].status', 'complete')).toThrow(
      /keyed array access.*not supported/i,
    );

    // The legitimate task entry remains untouched (no silent
    // misapplication side-effect either).
    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks[0].status).toBe('pending');
    expect(obj['tasks[id=T-001]']).toBeUndefined();

    // The legitimate by-index form continues to work and is the only
    // supported way to update one task in place.
    applyDotPath(obj, 'tasks[0].status', 'complete');
    expect(tasks[0].status).toBe('complete');
  });

  // ─── #1213 / CodeRabbit #18: malformed/compound bracket forms ─────────
  it('parsePath_CompoundBrackets_TasksZeroOne_ThrowsMalformedError', () => {
    // `tasks[0][1]` is a compound double-index form the parser does not
    // recognize. Without an explicit guard it would fall through and be
    // pushed as a literal property name — same silent-success bug
    // fix-004 closed for keyed access. Now rejected loudly.
    const obj: Record<string, unknown> = { tasks: [['a', 'b']] };

    expect(() => applyDotPath(obj, 'tasks[0][1]', 'updated')).toThrow(
      /malformed array access/i,
    );
  });

  it('parsePath_UnterminatedBracket_TasksKeyedNoClose_ThrowsMalformedError', () => {
    // `tasks[id=T-001` (no closing bracket) is not a valid bracket form.
    // The non-numeric guard requires `[...]`, so this falls past it. The
    // new compound/malformed guard catches it.
    const obj: Record<string, unknown> = { tasks: [{ id: 'T-001' }] };

    expect(() =>
      applyDotPath(obj, 'tasks[id=T-001.status', 'complete'),
    ).toThrow(/malformed array access/i);
  });

  it('parsePath_MismatchedCloseBracket_TasksClose_ThrowsMalformedError', () => {
    // `tasks]` has only a closing bracket. None of the bracket patterns
    // match, but the bare `]` should still be rejected as malformed.
    const obj: Record<string, unknown> = { tasks: [] };

    expect(() => applyDotPath(obj, 'tasks].status', 'complete')).toThrow(
      /malformed array access/i,
    );
  });
});

// ─── #1360 — Structured RESERVED_FIELD error data (PR 2 / T3) ──────────────
//
// `StateStoreError` carries a typed `data` block on `RESERVED_FIELD`
// rejections: `{rejectedPath, rule, alternateWritePath}`. Callers can
// pivot to the alternate write path (e.g. `transition` for `phase`)
// without parsing the message string.
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
      // Underscore guidance points at event.append rather than direct write.
      expect(sse.data?.alternateWritePath).toMatch(/event/i);
    }
  });

  // CodeRabbit follow-up: `isReservedField` returns true for any path whose
  // *segments* start with `_` (e.g. `foo._bar`), but the original
  // `resolveAlternateWritePath` only matched the `^_.*` regex against the
  // whole dotPath. That made `alternateWritePath` `null` for nested
  // underscore paths, weakening the structured-error contract.
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
      // Must point at the event-store guidance (matched the `^_.*` regex
      // against the inner segment), not be null.
      expect(sse.data?.alternateWritePath).toBeTruthy();
      expect(sse.data?.alternateWritePath).toMatch(/event/i);
    }
  });
});
