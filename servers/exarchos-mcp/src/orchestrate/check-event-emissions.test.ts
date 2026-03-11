// ─── Check Event Emissions Action Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import { EVENT_EMISSION_REGISTRY } from '../event-store/schemas.js';

// ─── Mock event store + materializer ────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

let mockViewState: Record<string, unknown> = {};

const mockMaterializer = {
  materialize: vi.fn(() => mockViewState),
  getState: vi.fn(() => null),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

import { PHASE_EXPECTED_EVENTS, handleCheckEventEmissions } from './check-event-emissions.js';

const STATE_DIR = '/tmp/test-check-event-emissions';

// ─── Task 5: PHASE_EXPECTED_EVENTS Registry Tests ──────────────────────────

describe('PHASE_EXPECTED_EVENTS', () => {
  it('PhaseExpectedEvents_DelegatePhase_ExpectsTeamEvents', () => {
    const delegateEvents = PHASE_EXPECTED_EVENTS['delegate'];
    expect(delegateEvents).toBeDefined();
    expect(delegateEvents).toContain('team.spawned');
    expect(delegateEvents).toContain('team.teammate.dispatched');
  });

  it('PhaseExpectedEvents_ReviewPhase_ExpectsReviewEvents', () => {
    const reviewEvents = PHASE_EXPECTED_EVENTS['review'];
    expect(reviewEvents).toBeDefined();
    expect(reviewEvents).toContain('review.routed');
  });

  it('PhaseExpectedEvents_SynthesizePhase_ExpectsStackAndShepherd', () => {
    const synthesizeEvents = PHASE_EXPECTED_EVENTS['synthesize'];
    expect(synthesizeEvents).toBeDefined();
    expect(synthesizeEvents).toContain('stack.submitted');
    expect(synthesizeEvents).toContain('shepherd.iteration');
  });

  it('CheckEventEmissions_DelegatePhase_IncludesTaskProgressed', () => {
    const delegateEvents = PHASE_EXPECTED_EVENTS['delegate'];
    expect(delegateEvents).toBeDefined();
    expect(delegateEvents).toContain('task.progressed');
  });

  it('PhaseExpectedEvents_AllEntries_OnlyModelEmitted', () => {
    for (const [phase, eventTypes] of Object.entries(PHASE_EXPECTED_EVENTS)) {
      for (const eventType of eventTypes) {
        expect(
          EVENT_EMISSION_REGISTRY[eventType],
          `Event '${eventType}' in phase '${phase}' should be model-emitted`,
        ).toBe('model');
      }
    }
  });
});

// ─── Task 6: handleCheckEventEmissions Tests ────────────────────────────────

describe('handleCheckEventEmissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewState = {};
  });

  it('CheckEventEmissions_MissingFeatureId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckEventEmissions(
      {} as { featureId: string },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('CheckEventEmissions_MalformedFeatureId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'INVALID_ID!' },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('CheckEventEmissions_MalformedWorkflowId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'valid-id', workflowId: 'BAD ID!!' },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('workflowId');
  });

  it('CheckEventEmissions_AllExpectedEventsPresent_ReturnsNoHints', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([
      { type: 'team.spawned', streamId: 'test', sequence: 1, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.task.planned', streamId: 'test', sequence: 2, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.teammate.dispatched', streamId: 'test', sequence: 3, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task.progressed', streamId: 'test', sequence: 4, timestamp: '2026-01-01T00:00:00Z' },
    ]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      phase: 'delegate',
      hints: [],
      complete: true,
      checked: 4,
      missing: 0,
    });
  });

  it('CheckEventEmissions_MissingTeamSpawned_ReturnsHint', async () => {
    mockViewState = { phase: 'delegate' };

    // Only team.task.planned, team.teammate.dispatched, and task.progressed present, missing team.spawned
    mockStore.query.mockResolvedValueOnce([
      { type: 'team.task.planned', streamId: 'test', sequence: 1, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.teammate.dispatched', streamId: 'test', sequence: 2, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task.progressed', streamId: 'test', sequence: 3, timestamp: '2026-01-01T00:00:00Z' },
    ]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    expect(result.data.phase).toBe('delegate');
    expect(result.data.complete).toBe(false);
    expect(result.data.missing).toBe(1);
    expect(result.data.hints).toHaveLength(1);
    expect(result.data.hints[0].eventType).toBe('team.spawned');
    expect(result.data.hints[0].description).toEqual(expect.any(String));
  });

  it('CheckEventEmissions_MissingEvent_IncludesRequiredFields', async () => {
    mockViewState = { phase: 'delegate' };

    // No events present at all — all delegate events missing
    mockStore.query.mockResolvedValueOnce([]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    const data = result.data as { hints: Array<{ eventType: string; requiredFields?: string[] }> };
    // team.spawned has required fields: teamSize, teammateNames, taskCount, dispatchMode
    const teamSpawnedHint = data.hints.find(h => h.eventType === 'team.spawned');
    expect(teamSpawnedHint).toBeDefined();
    expect(teamSpawnedHint!.requiredFields).toBeDefined();
    expect(teamSpawnedHint!.requiredFields).toContain('teamSize');
    expect(teamSpawnedHint!.requiredFields).toContain('teammateNames');
    expect(teamSpawnedHint!.requiredFields).toContain('taskCount');
    expect(teamSpawnedHint!.requiredFields).toContain('dispatchMode');
  });

  it('CheckEventEmissions_UnknownPhase_ReturnsEmptyHints', async () => {
    mockViewState = { phase: 'some-unknown-phase' };

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      phase: 'some-unknown-phase',
      hints: [],
      complete: true,
      checked: 0,
      missing: 0,
    });
  });

  it('CheckEventEmissions_EmitsGateEvent_FireAndForget', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([
      { type: 'team.spawned', streamId: 'test', sequence: 1, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.task.planned', streamId: 'test', sequence: 2, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.teammate.dispatched', streamId: 'test', sequence: 3, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task.progressed', streamId: 'test', sequence: 4, timestamp: '2026-01-01T00:00:00Z' },
    ]);

    await handleCheckEventEmissions({ featureId: 'test-feature' }, STATE_DIR);

    expect(mockStore.append).toHaveBeenCalled();
    const appendCall = mockStore.append.mock.calls[0];
    const event = appendCall[1] as {
      type: string;
      data: { gateName: string; layer: string; passed: boolean };
    };
    expect(event.type).toBe('gate.executed');
    expect(event.data.gateName).toBe('event-emissions');
    expect(event.data.layer).toBe('observability');
    expect(event.data.passed).toBe(true);
  });

  it('CheckEventEmissions_GateEmissionFailure_DoesNotBreakHandler', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([]);
    mockStore.append.mockRejectedValueOnce(new Error('disk full'));

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    expect(result.data.complete).toBe(false);
  });

  it('CheckEventEmissions_UsesWorkflowIdAsStreamId', async () => {
    mockViewState = { phase: 'delegate' };

    const { queryDeltaEvents } = await import('../views/tools.js');

    await handleCheckEventEmissions(
      { featureId: 'test-feature', workflowId: 'custom-stream' },
      STATE_DIR,
    );

    expect(queryDeltaEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'custom-stream',
      'workflow-state',
    );
  });
});

// ─── Task 7: Handler Registration Test ──────────────────────────────────────

describe('handleOrchestrate integration', () => {
  it('HandleOrchestrate_CheckEventEmissions_HandlerExists', async () => {
    const { handleOrchestrate } = await import('./composite.js');

    // Call with check_event_emissions action to verify it's routed
    const { EventStore } = await import('../event-store/store.js');
    const result = await handleOrchestrate(
      { action: 'check_event_emissions', featureId: 'test' },
      { stateDir: STATE_DIR, eventStore: new EventStore(STATE_DIR), enableTelemetry: false },
    );

    // Should NOT return UNKNOWN_ACTION — meaning the handler is registered
    expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
  });
});
