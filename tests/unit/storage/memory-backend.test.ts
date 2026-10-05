import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import type { EventSender } from '../../../src/storage/backend.js';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'workflow.started',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'ideate',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
      timestamp: '1970-01-01T00:00:00Z',
      phase: 'init',
      summary: 'Initial state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '1970-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  } as WorkflowState;
}

describe('InMemoryBackend Event Operations', () => {
  it('InMemoryBackend_listStreams_ReturnsEmpty_WhenNoEvents', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    expect(backend.listStreams()).toEqual([]);
  });

  it('InMemoryBackend_listStreams_ReturnsDistinctStreamIds', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    backend.appendEvent('stream-a', makeEvent({ streamId: 'stream-a', sequence: 1 }));
    backend.appendEvent('stream-a', makeEvent({ streamId: 'stream-a', sequence: 2 }));
    backend.appendEvent('stream-b', makeEvent({ streamId: 'stream-b', sequence: 1 }));

    const streams = backend.listStreams();
    expect(streams).toHaveLength(2);
    expect(streams).toContain('stream-a');
    expect(streams).toContain('stream-b');
  });
});

describe('InMemoryBackend State Operations', () => {
  it('InMemoryBackend_setState_GetState_Roundtrip', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    const retrieved = backend.getState('my-feature');
    expect(retrieved).toEqual(state);
  });

  /** The first `setState` gives version 1, so an expected version of 0 is stale. */
  it('InMemoryBackend_setState_CASConflict_Throws', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 0)).toThrow();
  });

  it('InMemoryBackend_setState_CASConflict_SucceedsWithCorrectVersion', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 1)).not.toThrow();

    const retrieved = backend.getState('my-feature');
    expect(retrieved).toEqual(updatedState);
  });

  it('InMemoryBackend_listStates_ReturnsAllStored', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state1 = makeState({ featureId: 'feature-a' });
    const state2 = makeState({ featureId: 'feature-b' });

    backend.setState('feature-a', state1);
    backend.setState('feature-b', state2);

    const states = backend.listStates();
    expect(states).toHaveLength(2);

    const featureIds = states.map((s) => s.featureId);
    expect(featureIds).toContain('feature-a');
    expect(featureIds).toContain('feature-b');
  });

  /**
   * A first write with no `expectedVersion` takes its version from
   * `state._version`, as for a state loaded from disk. Here the version is 3.
   */
  it('InMemoryBackend_setState_Seed_SyncsVersionFromState', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature', _version: 3 } as Partial<WorkflowState>);
    backend.setState('my-feature', state);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan', _version: 3 } as Partial<WorkflowState>);
    expect(() => backend.setState('my-feature', updatedState, 3)).not.toThrow();
  });

  it('InMemoryBackend_setState_Seed_CASFailsWithWrongVersion', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature', _version: 3 } as Partial<WorkflowState>);
    backend.setState('my-feature', state);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 1)).toThrow();
  });

  /** A seeded state with no `_version` gets version 1. */
  it('InMemoryBackend_setState_Seed_FallsBackToIncrementWhenNoVersion', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    delete (state as Record<string, unknown>)._version;
    backend.setState('my-feature', state);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 1)).not.toThrow();
  });

  /**
   * A write with `expectedVersion: 0` is an exclusive create. Its version is the
   * current version plus 1, not `state._version`. The fixture has `_version: 1`,
   * so both rules give version 1 here.
   */
  it('InMemoryBackend_setState_CASCreate_IgnoresStateVersion', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature', _version: 1 } as Partial<WorkflowState>);
    backend.setState('my-feature', state, 0);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 1)).not.toThrow();
  });
});

describe('InMemoryBackend Outbox Operations', () => {
  it('InMemoryBackend_addOutboxEntry_DrainOutbox_SendsAndRemoves', async () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    const entryId = backend.addOutboxEntry('test-stream', event);
    expect(typeof entryId).toBe('string');
    expect(entryId.length).toBeGreaterThan(0);

    const sentEvents: WorkflowEvent[] = [];
    const mockSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        for (const e of events) {
          sentEvents.push(e as unknown as WorkflowEvent);
        }
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result = await backend.drainOutbox('test-stream', mockSender);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(sentEvents).toHaveLength(1);

    const result2 = await backend.drainOutbox('test-stream', mockSender);
    expect(result2.sent).toBe(0);
  });
});

describe('InMemoryBackend View Cache Operations', () => {
  it('InMemoryBackend_getViewCache_ReturnsNullWhenEmpty', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const result = backend.getViewCache('test-stream', 'test-view');
    expect(result).toBeNull();
  });

  it('InMemoryBackend_setViewCache_GetViewCache_Roundtrip', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const viewState = { count: 42, items: ['a', 'b'] };
    backend.setViewCache('test-stream', 'my-view', viewState, 10);

    const cached = backend.getViewCache('test-stream', 'my-view');
    expect(cached).not.toBeNull();
    expect(cached!.state).toEqual(viewState);
    expect(cached!.highWaterMark).toBe(10);
  });
});

describe('InMemoryBackend Lifecycle', () => {
  it('InMemoryBackend_initialize_Close_NoOpSafely', () => {
    const backend = new InMemoryBackend();

    expect(() => backend.initialize()).not.toThrow();
    expect(() => backend.close()).not.toThrow();

    expect(() => backend.initialize()).not.toThrow();
    expect(() => backend.close()).not.toThrow();
  });
});

describe('InMemoryBackend Property Tests', () => {
  const arbFeatureId = fc
    .stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter((s) => s.length >= 1);

  const arbWorkflowState = arbFeatureId.map((featureId): WorkflowState =>
    makeState({ featureId }),
  );

  it('Roundtrip: getState(setState(x)) === x for all valid states', () => {
    fc.assert(
      fc.property(arbFeatureId, arbWorkflowState, (featureId, state) => {
        const backend = new InMemoryBackend();
        backend.initialize();

        const stateWithId = { ...state, featureId } as WorkflowState;
        backend.setState(featureId, stateWithId);

        const retrieved = backend.getState(featureId);
        expect(retrieved).toEqual(stateWithId);
      }),
    );
  });

  /** The two writes run in sequence. The first one moves the version to 2, so the second one always fails. */
  it('CAS: concurrent setState with same expectedVersion - exactly one succeeds', () => {
    fc.assert(
      fc.property(arbFeatureId, (featureId) => {
        const backend = new InMemoryBackend();
        backend.initialize();

        const state1 = makeState({ featureId });
        backend.setState(featureId, state1);

        const update1 = makeState({ featureId, phase: 'plan' });
        const update2 = makeState({ featureId, phase: 'delegate' });

        let success1 = false;
        let success2 = false;

        try {
          backend.setState(featureId, update1, 1);
          success1 = true;
        } catch {
        }

        try {
          backend.setState(featureId, update2, 1);
          success2 = true;
        } catch {
        }

        expect(success1).toBe(true);
        expect(success2).toBe(false);
      }),
    );
  });
});

/**
 * The fixture holds three `cor-X` events and three `cor-Y` events. The
 * `operationId` and `causationId` values split the same way.
 */
describe('InMemoryBackend queryEvents correlation filters (Wave 4 / #1437)', () => {
  function seedSplitByCorrelation(backend: InMemoryBackend): void {
    for (let i = 1; i <= 3; i++) {
      backend.appendEvent('test-stream', makeEvent({
        streamId: 'test-stream',
        sequence: i,
        type: 'workflow.started',
        operationId: 'op-X',
        correlationId: 'cor-X',
        causationId: 'cause-X',
      }));
    }
    for (let i = 4; i <= 6; i++) {
      backend.appendEvent('test-stream', makeEvent({
        streamId: 'test-stream',
        sequence: i,
        type: 'workflow.started',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        causationId: 'cause-Y',
      }));
    }
  }

  it('MemoryBackend_QueryEvents_FiltersByCorrelationId', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    seedSplitByCorrelation(backend);

    const results = backend.queryEvents('test-stream', { correlationId: 'cor-X' });

    expect(results).toHaveLength(3);
    for (const event of results) {
      expect(event.correlationId).toBe('cor-X');
    }
  });

  it('MemoryBackend_QueryEvents_FiltersByOperationId', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    seedSplitByCorrelation(backend);

    const results = backend.queryEvents('test-stream', { operationId: 'op-X' });

    expect(results).toHaveLength(3);
    for (const event of results) {
      expect(event.operationId).toBe('op-X');
    }
  });

  it('MemoryBackend_QueryEvents_FiltersByCausationId', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    seedSplitByCorrelation(backend);

    const results = backend.queryEvents('test-stream', { causationId: 'cause-X' });

    expect(results).toHaveLength(3);
    for (const event of results) {
      expect(event.causationId).toBe('cause-X');
    }
  });

  it('MemoryBackend_QueryEvents_CombinesCorrelationWithExistingFilters', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    seedSplitByCorrelation(backend);

    const results = backend.queryEvents('test-stream', {
      correlationId: 'cor-X',
      sinceSequence: 1,
    });

    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(2);
    expect(results[1].sequence).toBe(3);
    expect(results.every((e) => e.correlationId === 'cor-X')).toBe(true);
  });
});
