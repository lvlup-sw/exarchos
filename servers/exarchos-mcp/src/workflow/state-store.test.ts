import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deepMerge, isPlainObject, initStateFile, reconcileFromEvents } from './state-store.js';
import { EventStore } from '../event-store/store.js';

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

// ─── reconcileFromEvents Query Efficiency ─────────────────────────────────

describe('reconcileFromEvents query efficiency', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-query-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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

    // Assert: eventStore.query should be called at most once for the delta path
    // (the code currently calls it twice: once for delta, once for phase reconciliation)
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledWith('query-test', { sinceSequence: 2 });

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

    // Should only query once (delta), not twice (delta + full)
    expect(querySpy).toHaveBeenCalledTimes(1);

    querySpy.mockRestore();
  });
});
