import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';
import { EVENT_EMISSION_REGISTRY } from '../../../../src/events/schemas.js';
import type { EventType } from '../../../../src/events/schemas.js';
import type { EventStore } from '../../../../src/events/store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

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

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

/**
 * The gate folds its view to the durable tail of the stream through `foldToTail`, and these tests stub that fold.
 * `tests/unit/projections/fold-at-tail.test.ts` covers the fold against a real store.
 * The fixtures are the whole stream, so the stub reports a sequence at or past every fixture event.
 */
const AT_TAIL = Number.MAX_SAFE_INTEGER;

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: vi.fn(async () => ({ view: mockViewState, sequence: AT_TAIL })),
}));

import {
  EVENT_DESCRIPTIONS,
  PHASE_EXPECTED_EVENTS,
  handleCheckEventEmissions,
} from '../../../../src/verbs/gates/check-event-emissions.js';
import {
  PHASE_EVENT_CONTRACTS,
  assertPhaseEventContracts,
} from '../../../../src/workflow/topology/phase-events.js';

const STATE_DIR = '/tmp/test-check-event-emissions';

describe('PHASE_EXPECTED_EVENTS', () => {
  it('PhaseExpectedEvents_DelegatePhase_ExpectsTeamEvents', () => {
    const delegateEvents = PHASE_EXPECTED_EVENTS['delegate'];
    expect(delegateEvents).toBeDefined();
    expect(delegateEvents).toContain('team.spawned');
    expect(delegateEvents).toContain('team.teammate.dispatched');
  });

  /** The runtime emits `review.routed` from `review/tools.ts`, so the model-emitted review set must not list it. */
  it('PhaseExpectedEvents_ReviewPhase_ExpectsReviewEvents', () => {
    const reviewEvents = PHASE_EXPECTED_EVENTS['review'];
    expect(reviewEvents).toBeDefined();
    expect(reviewEvents).not.toContain('review.routed');
    expect(reviewEvents).toContain('team.spawned');
  });

  /** The contract check at load throws when a phase expects an `auto` event such as `review.routed`. */
  it('CheckEventEmissions_ReviewRouted_NotExpectedFromModel', () => {
    for (const [, eventTypes] of Object.entries(PHASE_EXPECTED_EVENTS)) {
      expect(eventTypes).not.toContain('review.routed');
    }
  });

  /** With no events, every expected review event is missing. The auto-emitted `review.routed` must get no hint. */
  it('CheckEventEmissions_ReviewPhase_OmitsRoutedFromMissingHints', async () => {
    mockViewState = { phase: 'review' };
    mockStore.query.mockResolvedValueOnce([]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as { hints: Array<{ eventType: string }> };
    expect(data.hints.map((h) => h.eventType)).not.toContain('review.routed');
  });

  /** `stack.submitted` is a telemetry event, so neither the synthesize row nor the hint table lists it. The literal list is pinned on purpose. */
  it('PhaseExpectedEvents_SynthesizePhase_ExpectsShepherdAndNoLongerStackSubmitted', () => {
    expect(PHASE_EXPECTED_EVENTS['synthesize']).toEqual([
      'team.spawned',
      'team.disbanded',
      'shepherd.iteration',
    ]);
    expect(Object.keys(EVENT_DESCRIPTIONS)).not.toContain('stack.submitted');
  });

  /** Both tables project the phase event contract, so they cannot drift. The gate suite pins this to state what the gate relies on. */
  it('EventDescriptions_AreTotalOverTheExpectedTypes', () => {
    const expected = new Set(Object.values(PHASE_EXPECTED_EVENTS).flat());
    expect(expected.size).toBeGreaterThan(0);
    expect([...expected].filter((type) => EVENT_DESCRIPTIONS[type] === undefined)).toEqual([]);
    expect(Object.keys(EVENT_DESCRIPTIONS).filter((type) => !expected.has(type))).toEqual([]);
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

  /**
   * A phase that expects an `auto` event must throw at contract load.
   * The test calls the real `assertPhaseEventContracts` on a seeded row that expects `review.routed`.
   */
  it('PhaseExpectedEvents_AutoEventListed_IsRefusedWhereTheContractLoads', () => {
    expect(EVENT_EMISSION_REGISTRY['review.routed']).toBe('auto');
    expect(() =>
      assertPhaseEventContracts({
        review: {
          expects: [
            { type: 'team.spawned', when: 'seeded' },
            { type: 'review.routed', when: 'seeded' },
          ],
          runtimeEmits: [],
        },
      }),
    ).toThrow(/expects 'review\.routed', whose emission source is 'auto'/);
    expect(() => assertPhaseEventContracts(PHASE_EVENT_CONTRACTS)).not.toThrow();
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

  /**
   * Runs a local copy of a model-only check on a phase set that lists `review.routed`, an `auto` event.
   * The copy must throw for that set and must pass for `PHASE_EXPECTED_EVENTS`.
   */
  it('PhaseExpectedEvents_AutoEventListed_ThrowsAtModuleLoad', () => {
    expect(EVENT_EMISSION_REGISTRY['review.routed']).toBe('auto');

    const assertModelOnly = (
      phaseSets: Readonly<Record<string, readonly EventType[]>>,
    ): void => {
      for (const [, eventTypes] of Object.entries(phaseSets)) {
        for (const eventType of eventTypes) {
          if (EVENT_EMISSION_REGISTRY[eventType] !== 'model') {
            throw new Error(
              `PHASE_EXPECTED_EVENTS contains non-model event '${eventType}' ` +
                `(source: ${EVENT_EMISSION_REGISTRY[eventType]})`,
            );
          }
        }
      }
    };

    const offendingPhaseSets: Readonly<Record<string, readonly EventType[]>> = {
      review: ['team.spawned', 'review.routed'],
    };

    expect(() => assertModelOnly(offendingPhaseSets)).toThrow(
      /non-model event 'review\.routed'.*source: auto/,
    );

    expect(() => assertModelOnly(PHASE_EXPECTED_EVENTS)).not.toThrow();
  });
});

describe('handleCheckEventEmissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewState = {};
  });

  it('CheckEventEmissions_MissingFeatureId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckEventEmissions(
      {} as { featureId: string },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('CheckEventEmissions_MalformedFeatureId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'INVALID_ID!' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('CheckEventEmissions_MalformedWorkflowId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'valid-id', workflowId: 'BAD ID!!' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('workflowId');
  });

  /** The delegate phase expects five model-emitted events. The runtime appends `task.assigned`, so the phase does not expect it. */
  it('CheckEventEmissions_AllExpectedEventsPresent_ReturnsNoHints', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([
      { type: 'team.spawned', streamId: 'test', sequence: 2, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.task.planned', streamId: 'test', sequence: 3, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.teammate.dispatched', streamId: 'test', sequence: 4, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.disbanded', streamId: 'test', sequence: 5, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task.progressed', streamId: 'test', sequence: 6, timestamp: '2026-01-01T00:00:00Z' },
    ]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      phase: 'delegate',
      hints: [],
      complete: true,
      checked: 5,
      missing: 0,
    });
  });

  /** Seeds every expected delegate event except `team.spawned`. */
  it('CheckEventEmissions_MissingTeamSpawned_ReturnsHint', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([
      { type: 'task.assigned', streamId: 'test', sequence: 1, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.task.planned', streamId: 'test', sequence: 2, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.teammate.dispatched', streamId: 'test', sequence: 3, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.disbanded', streamId: 'test', sequence: 4, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task.progressed', streamId: 'test', sequence: 5, timestamp: '2026-01-01T00:00:00Z' },
    ]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
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

    mockStore.query.mockResolvedValueOnce([]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as { hints: Array<{ eventType: string; requiredFields?: string[] }> };
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
      mockStore as unknown as EventStore,
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

  /** Seeds every expected delegate event, so the gate event records `passed: true`. */
  it('CheckEventEmissions_EmitsGateEvent_FireAndForget', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([
      { type: 'task.assigned', streamId: 'test', sequence: 1, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.spawned', streamId: 'test', sequence: 2, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.task.planned', streamId: 'test', sequence: 3, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.teammate.dispatched', streamId: 'test', sequence: 4, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'team.disbanded', streamId: 'test', sequence: 5, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task.progressed', streamId: 'test', sequence: 6, timestamp: '2026-01-01T00:00:00Z' },
    ]);

    await handleCheckEventEmissions({ featureId: 'test-feature' }, STATE_DIR, mockStore as unknown as EventStore);

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

  /**
   * The `event-emissions` gate declares `gate.executed`. When the append fails, the handler withholds the success result.
   * The gate verdict stays readable on `data`.
   */
  it('CheckEventEmissions_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([]);
    mockStore.append.mockRejectedValueOnce(new Error('disk full'));

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
    const data = result.data as { complete: boolean };
    expect(data.complete).toBe(false);
  });

  it('CheckEventEmissions_UsesWorkflowIdAsStreamId', async () => {
    mockViewState = { phase: 'delegate' };

    const { foldToTail } = await import('../../../../src/projections/fold-at-tail.js');

    await handleCheckEventEmissions(
      { featureId: 'test-feature', workflowId: 'custom-stream' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(foldToTail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'custom-stream',
      'workflow-state',
    );
  });
});

describe('handleOrchestrate integration', () => {
  it('HandleOrchestrate_CheckEventEmissions_HandlerExists', async () => {
    const { handleOrchestrate } = await import('../../../../src/verbs/composite.js');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const isolatedDir = mkdtempSync(join(tmpdir(), 'check-event-emissions-route-'));
    try {
      const { EventStore } = await import('../../../../src/events/store.js');
      const eventStore = new EventStore(isolatedDir);
      await eventStore.initialize();
      const result = await handleOrchestrate(
        { action: 'check_event_emissions', featureId: 'test' },
        { stateDir: isolatedDir, eventStore, enableTelemetry: false },
      );

      expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    } finally {
      rmrf(isolatedDir);
    }
  });
});
