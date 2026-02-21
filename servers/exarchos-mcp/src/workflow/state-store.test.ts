import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  deepMerge,
  isPlainObject,
  readStateFile,
  writeStateFile,
  initStateFile,
  listStateFiles,
  configureStateStoreBackend,
  VersionConflictError,
  StateStoreError,
} from './state-store.js';
import { InMemoryBackend, VersionConflictError as BackendVersionConflictError } from '../storage/memory-backend.js';
import type { WorkflowState } from './types.js';

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

// ─── Task 16: State Store StorageBackend Integration ─────────────────────────

describe('State Store StorageBackend Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'state-store-backend-test-'));
  });

  afterEach(async () => {
    // Reset module-level backend to null after each test
    configureStateStoreBackend(undefined as unknown as InMemoryBackend);
    await rm(tempDir, { recursive: true, force: true });
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
    expect(stored!.phase).toBe('ideate');
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
    expect(result.phase).toBe('ideate');
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
    await rm(tempDir, { recursive: true, force: true });
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
