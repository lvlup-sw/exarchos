import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleNextAction, configureNextActionEventStore } from './next-action.js';
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

describe('handleNextAction', () => {
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend();
    configureStateStoreBackend(backend);
    configureNextActionEventStore(null);
  });

  afterEach(() => {
    configureStateStoreBackend(undefined);
    configureNextActionEventStore(null);
  });

  it('handleNextAction_FinalPhase_ReturnsDone', async () => {
    const state = makeBaseState({ phase: 'completed' });
    backend.setState('test-feature', state as never, 0);

    const result = await handleNextAction(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('DONE');
    expect(data.phase).toBe('completed');
  });

  it('handleNextAction_HumanCheckpoint_ReturnsWait', async () => {
    // 'plan-review' is a human checkpoint in feature workflow
    const state = makeBaseState({ phase: 'plan-review' });
    backend.setState('test-feature', state as never, 0);

    const result = await handleNextAction(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('WAIT:human-checkpoint:plan-review');
    expect(data.phase).toBe('plan-review');
  });

  it('handleNextAction_GuardPasses_ReturnsAutoAction', async () => {
    // ideate -> plan requires designArtifactExists guard
    const state = makeBaseState({
      phase: 'ideate',
      artifacts: { design: '/path/to/design.md', plan: null, pr: null },
    });
    backend.setState('test-feature', state as never, 0);

    const result = await handleNextAction(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:plan');
    expect(data.target).toBe('plan');
  });

  it('handleNextAction_NoGuardPasses_ReturnsWaitInProgress', async () => {
    // ideate with no design artifact means guard fails -> no transition possible
    const state = makeBaseState({
      phase: 'ideate',
      artifacts: { design: null, plan: null, pr: null },
    });
    backend.setState('test-feature', state as never, 0);

    const result = await handleNextAction(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('WAIT:in-progress:ideate');
    expect(data.phase).toBe('ideate');
  });

  it('handleNextAction_CircuitOpen_ReturnsBlocked', async () => {
    // 'review' in feature workflow is inside 'implementation' compound
    // review -> delegate is a fix-cycle transition with guard 'anyReviewFailed'
    const state = makeBaseState({
      phase: 'review',
      reviews: { r1: { status: 'fail' } },
    });
    backend.setState('test-feature', state as never, 0);

    // Create events showing 3 fix-cycles (max is 3 for 'implementation' compound)
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
      {
        streamId: 'test-feature',
        sequence: 3,
        timestamp: NOW,
        type: 'workflow.fix-cycle',
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
    configureNextActionEventStore(mockStore);

    const result = await handleNextAction(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('BLOCKED:circuit-open:implementation');
    expect(data.fixCycleCount).toBe(3);
    expect(data.maxFixCycles).toBe(3);
  });

  it('handleNextAction_FixCycleGuard_ReturnsDelegateFixes', async () => {
    // review -> delegate is a fix-cycle transition
    // With anyReviewFailed guard passing and circuit breaker NOT open
    const state = makeBaseState({
      phase: 'review',
      reviews: { r1: { status: 'fail' } },
    });
    backend.setState('test-feature', state as never, 0);

    // No fix-cycle events yet, circuit is closed
    const mockEvents: WorkflowEvent[] = [
      {
        streamId: 'test-feature',
        sequence: 1,
        timestamp: NOW,
        type: 'workflow.compound-entry',
        schemaVersion: '1.0',
        data: { compoundStateId: 'implementation' },
      },
    ];
    const mockStore = createMockEventStore(mockEvents);
    configureNextActionEventStore(mockStore);

    const result = await handleNextAction(
      { featureId: 'test-feature' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // The first matching guard: allReviewsPassed fails (status fail),
    // anyReviewFailed passes (is fix-cycle) -> returns delegate:--fixes
    expect(data.action).toBe('AUTO:delegate:--fixes');
    expect(data.target).toBe('delegate');
  });

  it('handleNextAction_NonExistentState_ReturnsError', async () => {
    const result = await handleNextAction(
      { featureId: 'nonexistent' },
      '/fake/state-dir',
    );

    expect(result.success).toBe(false);
    const error = result.error as { code: string; message: string };
    expect(error.code).toBe('STATE_NOT_FOUND');
    expect(error.message).toContain('nonexistent');
  });
});
