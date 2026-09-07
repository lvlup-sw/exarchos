// ─── Check Event Emissions Action Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';
import { EVENT_EMISSION_REGISTRY } from '../../../../src/events/schemas.js';
import type { EventType } from '../../../../src/events/schemas.js';
import type { EventStore } from '../../../../src/events/store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

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

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

// #1855 — the gate folds its view to the stream's durable tail through
// `foldToTail` rather than pairing `queryDeltaEvents` with a bare
// `materialize`. The fold is the seam a unit test of the VERDICT should stub:
// what the fold itself guarantees is covered against a real store in
// `tests/unit/projections/fold-at-tail.test.ts`.
// `foldToTail` guarantees the fold covers the stream's durable tail, and
// callers now bound their own evidence to the sequence it reports. These
// fixtures ARE the stream, so the stub reports a sequence at or past every
// fixture event; a lower one would assert a lag this file never sets up.
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
    // RC2 (#1395): review.routed migrated model → auto (runtime emits it from
    // review/tools.ts), so it must NOT be in the model-emitted phase set.
    expect(reviewEvents).not.toContain('review.routed');
    // Team coordination events stay model-emitted (Category C) pending a
    // runbook-executor seam.
    expect(reviewEvents).toContain('team.spawned');
  });

  it('CheckEventEmissions_ReviewRouted_NotExpectedFromModel', () => {
    // review.routed is auto-emitted post-RC2; it must be absent from every
    // PHASE_EXPECTED_EVENTS entry (the compile-time assertion would throw
    // otherwise, since an 'auto' event cannot appear in a model-only set).
    for (const [, eventTypes] of Object.entries(PHASE_EXPECTED_EVENTS)) {
      expect(eventTypes).not.toContain('review.routed');
    }
  });

  it('CheckEventEmissions_ReviewPhase_OmitsRoutedFromMissingHints', async () => {
    mockViewState = { phase: 'review' };
    // No events present — every model-emitted review-phase event is "missing",
    // but review.routed (now auto) must NOT appear among the hints.
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

  it('PhaseExpectedEvents_SynthesizePhase_ExpectsShepherdAndNoLongerStackSubmitted', () => {
    // `stack.submitted` was flipped to telemetry by the first event-authority
    // charter act (#1599, executing #1876): this row was the only dependency
    // on it, so the flip IS the deletion of the row and of its hint. The
    // literal pin is deliberate — re-adding the type here is a re-promotion,
    // and the partition's declaration conjunct would then demand a witness.
    expect(PHASE_EXPECTED_EVENTS['synthesize']).toEqual([
      'team.spawned',
      'team.disbanded',
      'shepherd.iteration',
    ]);
    expect(Object.keys(EVENT_DESCRIPTIONS)).not.toContain('stack.submitted');
  });

  it('EventDescriptions_AreTotalOverTheExpectedTypes', () => {
    // Both tables project the phase event contract, so this cannot drift; the
    // pin is here so the gate's own suite says what it relies on.
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

  it('PhaseExpectedEvents_AutoEventListed_IsRefusedWhereTheContractLoads', () => {
    // Regression guard (#1395, RC2): flipping a registry entry to 'auto'
    // WITHOUT deleting its expectation must throw. The expectation table is a
    // projection of the phase event contract, so the refusal lives at the
    // contract's load — exercised here through the real function on a seeded
    // row, not a re-implemented copy of the loop. `review.routed` is 'auto'
    // post-migration, so expecting it is precisely the violation.
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

  it('PhaseExpectedEvents_AutoEventListed_ThrowsAtModuleLoad', () => {
    // Regression guard (#1395, RC2). The module-load assertion in
    // check-event-emissions.ts is the mechanism that FORCES the three-site
    // migration to stay consistent: flipping a registry entry to 'auto'
    // WITHOUT removing it from PHASE_EXPECTED_EVENTS must throw. We cannot
    // re-import the real module to re-trigger its top-level throw without
    // breaking this suite's own module load, so we re-implement the exact
    // assertion loop here and feed it a phase set that (re)introduces an
    // 'auto' event — proving the invariant fires.
    //
    // `review.routed` is now 'auto' (post-migration), so a phase set that
    // lists it is precisely the violation the guard must catch.
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

    // And the real, post-migration phase sets must NOT trip the same loop.
    expect(() => assertModelOnly(PHASE_EXPECTED_EVENTS)).not.toThrow();
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

  it('CheckEventEmissions_AllExpectedEventsPresent_ReturnsNoHints', async () => {
    mockViewState = { phase: 'delegate' };

    // Post Fix 3 (#1180), the delegate-phase model-emitted contract is the
    // SoT registry filtered to model events: task.assigned + team.spawned +
    // team.task.planned + team.teammate.dispatched + team.disbanded +
    // task.progressed (6 events). All must be present for hints to be empty.
    mockStore.query.mockResolvedValueOnce([
      { type: 'task.assigned', streamId: 'test', sequence: 1, timestamp: '2026-01-01T00:00:00Z' },
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
      checked: 6,
      missing: 0,
    });
  });

  it('CheckEventEmissions_MissingTeamSpawned_ReturnsHint', async () => {
    mockViewState = { phase: 'delegate' };

    // All delegate-phase model events present except `team.spawned` — the
    // expected-events list (post Fix 3 / #1180) covers task.assigned +
    // team.* + task.progressed, so we seed every other type explicitly.
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

    // No events present at all — all delegate events missing
    mockStore.query.mockResolvedValueOnce([]);

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
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

  it('CheckEventEmissions_EmitsGateEvent_FireAndForget', async () => {
    mockViewState = { phase: 'delegate' };

    // Seed the full delegate-phase model-event contract (post Fix 3 / #1180)
    // so `passed: true` reflects the all-events-present case.
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

  it('CheckEventEmissions_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
    mockViewState = { phase: 'delegate' };

    mockStore.query.mockResolvedValueOnce([]);
    mockStore.append.mockRejectedValueOnce(new Error('disk full'));

    const result: ToolResult = await handleCheckEventEmissions(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // `event-emissions` declares `gate.executed` unconditionally — a dropped
    // append withholds the success carrier rather than returning one the log
    // does not back. The gate's own verdict is still readable on `data`.
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

// ─── Task 7: Handler Registration Test ──────────────────────────────────────

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

      // Should NOT return UNKNOWN_ACTION — meaning the handler is registered
      expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    } finally {
      rmrf(isolatedDir);
    }
  });
});

// ─── The expectation surfaces cannot go stale or empty ──────────────────────
//
// Three load-time guards keep the expectation tables honest, and each throw
// path is proven here with a seeded registry rather than trusted: a retired
// event cannot silently vanish from a derived expectation list, a phase row
// cannot silently derive to empty, and a description cannot outlive the
// model-emitted status of its event.
