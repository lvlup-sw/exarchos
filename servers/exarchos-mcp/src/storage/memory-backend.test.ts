import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { EventSender } from './backend.js';
import { InMemoryBackend } from './memory-backend.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── State Operations ───────────────────────────────────────────────────────

describe('InMemoryBackend State Operations', () => {
  it('InMemoryBackend_setState_GetState_Roundtrip', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    const retrieved = backend.getState('my-feature');
    expect(retrieved).toEqual(state);
  });

  it('InMemoryBackend_setState_CASConflict_Throws', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    // The current version after first set is 1.
    // Attempting to set with expectedVersion 0 (stale) should throw.
    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 0)).toThrow();
  });

  it('InMemoryBackend_setState_CASConflict_SucceedsWithCorrectVersion', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    // Version after first set is 1; CAS with expectedVersion=1 should succeed
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
});

// ─── Outbox Operations ──────────────────────────────────────────────────────

describe('InMemoryBackend Outbox Operations', () => {
  it('InMemoryBackend_addOutboxEntry_DrainOutbox_SendsAndRemoves', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    const entryId = backend.addOutboxEntry('test-stream', event);
    expect(typeof entryId).toBe('string');
    expect(entryId.length).toBeGreaterThan(0);

    // Create a mock sender
    const sentEvents: WorkflowEvent[] = [];
    const mockSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        for (const e of events) {
          sentEvents.push(e as unknown as WorkflowEvent);
        }
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result = backend.drainOutbox('test-stream', mockSender);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(sentEvents).toHaveLength(1);

    // Draining again should find nothing
    const result2 = backend.drainOutbox('test-stream', mockSender);
    expect(result2.sent).toBe(0);
  });
});

// ─── View Cache Operations ──────────────────────────────────────────────────

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

// ─── Lifecycle Operations ───────────────────────────────────────────────────

describe('InMemoryBackend Lifecycle', () => {
  it('InMemoryBackend_initialize_Close_NoOpSafely', () => {
    const backend = new InMemoryBackend();

    // Should not throw
    expect(() => backend.initialize()).not.toThrow();
    expect(() => backend.close()).not.toThrow();

    // Calling twice should also be safe
    expect(() => backend.initialize()).not.toThrow();
    expect(() => backend.close()).not.toThrow();
  });
});

// ─── Property-Based Tests ───────────────────────────────────────────────────

describe('InMemoryBackend Property Tests', () => {
  // Arbitrary for a valid featureId (lowercase alphanumeric + hyphens, min length 1)
  const arbFeatureId = fc
    .stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter((s) => s.length >= 1);

  // Arbitrary for a valid WorkflowState - use a realistic structure
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

  it('CAS: concurrent setState with same expectedVersion - exactly one succeeds', () => {
    fc.assert(
      fc.property(arbFeatureId, (featureId) => {
        const backend = new InMemoryBackend();
        backend.initialize();

        const state1 = makeState({ featureId });
        backend.setState(featureId, state1);

        // Both try to set with expectedVersion 1
        const update1 = makeState({ featureId, phase: 'plan' });
        const update2 = makeState({ featureId, phase: 'delegate' });

        let success1 = false;
        let success2 = false;

        try {
          backend.setState(featureId, update1, 1);
          success1 = true;
        } catch {
          // CAS conflict
        }

        try {
          backend.setState(featureId, update2, 1);
          success2 = true;
        } catch {
          // CAS conflict
        }

        // Exactly one should succeed (first always succeeds, second always fails
        // because version was bumped)
        expect(success1).toBe(true);
        expect(success2).toBe(false);
      }),
    );
  });
});
