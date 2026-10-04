// Tests for the live shadow observer.
//
// The observer records the cutover-gate evidence (phase kind, outcome and a typed shadow decision) and does not change production behavior.
// It records guarded-edge attempts and skips unmodelled edges. It classifies a known legacy defect as a legacy-allow, admission-deny disagreement.
// It isolates its own errors. Through the real guard, the transition result equals the unobserved result, and the sink still records the attempt.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultHSMTransitionGuard } from '../../../../src/workflow/hsm-transition-guard.js';
import { defaultTranslationContext } from '../../../../src/workflow/admission/legacy-state-translation.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
} from '../../../../src/events/schemas.js';
import { handleWorkflow } from '../../../../src/workflow/composite.js';
import { handleSet } from '../../../../src/workflow/tools.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  InMemoryLiveShadowSink,
  LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT,
  LiveShadowHealthCounter,
  ZERO_LIVE_SHADOW_HEALTH,
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  liveShadowHealth,
  liveShadowObserverStatus,
  observeLiveTransition,
  recordLiveTransition,
  liveShadowSink,
  type LiveShadowObservationRecord,
} from '../../../../src/workflow/admission/live-shadow-observer.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  evaluateCutoverGate,
  readDurableShadowAttempts,
} from '../../../../src/workflow/admission/cutover-gate.js';
import type { PolicyAuthority } from '../../../../src/workflow/admission/policy-authority.js';
import type {
  LegacyTransitionObservation,
  ShadowDecisionRecord,
} from '../../../../src/workflow/admission/shadow-decision.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

function deps(
  sink: InMemoryLiveShadowSink,
  health = new LiveShadowHealthCounter(),
) {
  return { sink, context: CTX, health };
}

describe('observeLiveTransition — records the cutover-gate substrate', () => {
  /** The plan is present, so admission also allows and the two decisions agree. */
  it('records a guarded-edge attempt with the target phase kind + legacy outcome', () => {
    const sink = new InMemoryLiveShadowSink();
    observeLiveTransition(
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'plan-review',
        legacyOutcome: 'allow',
        idempotent: false,
      },
      { artifacts: { plan: 'docs/x.md' } },
      deps(sink),
    );
    expect(sink.size).toBe(1);
    expect(sink.liveAttempts()[0]).toEqual({
      phaseKind: 'PLAN',
      outcome: 'allow',
      disagreementClass: 'agree',
    });
    expect(sink.decisionRecords()[0]?.disagreementClass).toBe('agree');
  });

  /** The legacy `implementation-complete` guard always passes, but admission denies when `implementation.complete` is false. */
  it('classifies a known legacy defect as legacy-allow / admission-deny (unexplained)', () => {
    const sink = new InMemoryLiveShadowSink();
    observeLiveTransition(
      {
        workflowType: 'debug',
        fromPhase: 'debug-implement',
        toPhase: 'debug-validate',
        legacyOutcome: 'allow',
        idempotent: false,
      },
      { implementation: { complete: false } },
      deps(sink),
    );
    const record = sink.decisionRecords()[0];
    expect(record?.disagreementClass).toBe('legacy-allow-admission-deny');
    expect(record?.disposition).toBe('unexplained');
    expect(record?.explained).toBe(false);
    expect(sink.liveAttempts()[0]).toEqual({
      phaseKind: 'REVIEW',
      outcome: 'allow',
      disagreementClass: 'legacy-allow-admission-deny',
    });
  });

  /** `plan → cancelled` is a universal edge, not a guarded IR edge. */
  it('skips an unmodelled edge (no shared-IR entry) without recording', () => {
    const sink = new InMemoryLiveShadowSink();
    observeLiveTransition(
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'cancelled',
        legacyOutcome: 'allow',
        idempotent: false,
      },
      {},
      deps(sink),
    );
    expect(sink.size).toBe(0);
  });

  it('is error-isolated — a throwing sink never propagates', () => {
    const throwingSink = {
      record(): void {
        throw new Error('sink boom');
      },
    };
    expect(() =>
      observeLiveTransition(
        {
          workflowType: 'feature',
          fromPhase: 'plan',
          toPhase: 'plan-review',
          legacyOutcome: 'allow',
          idempotent: false,
        },
        { artifacts: { plan: 'x' } },
        { sink: throwingSink, context: CTX, health: new LiveShadowHealthCounter() },
      ),
    ).not.toThrow();
  });
});

describe('InMemoryLiveShadowSink — bounded accumulation', () => {
  it('drops the oldest record beyond capacity', () => {
    const sink = new InMemoryLiveShadowSink(2);
    const mk = (i: number): LiveShadowObservationRecord => ({
      attempt: { phaseKind: 'PLAN', outcome: 'allow', disagreementClass: 'agree' },
      decision: {
        attempt: {
          workflowType: 'feature',
          fromPhase: 'a',
          toPhase: 'b',
          phaseKind: 'PLAN',
          attemptId: String(i),
        },
        legacyOutcome: 'allow',
        admission: { status: 'evaluated', verdict: 'allow' },
        disagreementClass: 'agree',
        disposition: 'agree',
        explained: true,
        reason: 'ok',
      },
      edgeKey: `feature:a:b#${i}`,
    });
    sink.record(mk(1));
    sink.record(mk(2));
    sink.record(mk(3));
    expect(sink.size).toBe(2);
    expect(sink.snapshot().map((r) => r.edgeKey)).toEqual([
      'feature:a:b#2',
      'feature:a:b#3',
    ]);
  });
});

describe('exit-proof (c) — production wiring is behaviour-preserving', () => {
  const guard = new DefaultHSMTransitionGuard();
  const featureId = 'live-observer-test';

  beforeEach(() => {
    liveShadowSink.clear();
  });

  it('guard result is byte-identical with vs without the live observer', async () => {
    const state = { featureId, phase: 'plan', artifacts: { plan: 'docs/x.md' } };
    const withObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...state },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: (o) => recordLiveTransition(o, { ...state }, null),
    });
    const withoutObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...state },
      workflowType: 'feature',
      eventStore: null,
    });
    expect(withObserver).toEqual(withoutObserver);
    expect(withObserver.ok).toBe(true);
  });

  it('the live sink accumulates the attempt from the wired guard path', async () => {
    const state = { featureId, phase: 'plan', artifacts: { plan: 'docs/x.md' } };
    await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...state },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: (o) => recordLiveTransition(o, { ...state }, null),
    });
    expect(liveShadowSink.size).toBe(1);
    expect(liveShadowSink.liveAttempts()[0]).toEqual({
      phaseKind: 'PLAN',
      outcome: 'allow',
      disagreementClass: 'agree',
    });
  });
});

/**
 * The durable assertions read the events back out of a real file-backed `EventStore`, not out of the in-memory buffer or the appended payload.
 * The tests that transition through `handleWorkflow` or `dispatch()` supply only `DispatchContext.eventStore`, the ordinary dispatch contract.
 * The path from `ctx.eventStore` through `handleSet`, `GuardContext.eventStore` and `notifyShadowObserver` to `recordLiveTransition` is production code.
 * If `notifyShadowObserver` forwards `null`, those tests fail.
 * `handleCancel` and `handleCleanup` pass their own store to the observer, so each of them has its own test.
 */
describe('DR-23 / T-31 — durable shadow evidence from the production path', () => {
  let stateDir: string;
  let eventStore: EventStore;

  function ctx() {
    return { stateDir, eventStore, enableTelemetry: false };
  }

  /** The setup injects nothing, so the observer gets its durable store from production wiring alone. */
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'live-shadow-durable-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    liveShadowSink.clear();
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    liveShadowSink.clear();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  /**
   * The transition runs through the composite handler, `handleSet`, the HSM guard and `GuardContext.shadowObserver`.
   * The registered schema parses the event that the store returns, not the object that the observer appended.
   * The fact names the attempt that this transition allocated, not the predecessor attempt.
   * An agreement writes no disposition fact, because the disposition enum has no `agree` member.
   * No shadow event appears on the feature stream, where a fire-and-forget append can race the CAS writes in `handleSet`.
   */
  it('ShadowObserver_LiveTransition_EmitsDurableShadowAttempt', async () => {
    const featureId = 'durable-shadow-attempt';

    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      stateDir,
      eventStore,
    );

    const transition = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(transition.success).toBe(true);

    await flushLiveShadowEvidence();

    const persisted = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    expect(persisted.length).toBe(1);
    const event = persisted[0]!;
    expect(event.type).toBe('admission.shadow-attempt');
    expect(event.source).toBe('live-shadow-observer');

    const data = AdmissionShadowAttemptData.parse(event.data);
    expect(data.legacyOutcome).toBe('allow');
    expect(data.subject.kind).toBe('phase-attempt');
    expect(data.decision.outcome).toBe('allow');
    expect(data.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(data.caller.principalKind).toBe('service');

    const persistedState = JSON.parse(
      await readFile(join(stateDir, `${featureId}.state.json`), 'utf-8'),
    ) as Record<string, unknown>;
    expect(persistedState.phaseAttemptId).toBeDefined();
    expect(data.phaseAttemptId).toBe(persistedState.phaseAttemptId);

    expect(
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.disagreement-disposition',
      }),
    ).toEqual([]);

    const authoritative = await eventStore.query(featureId);
    expect(authoritative.length).toBeGreaterThan(0);
    expect(authoritative.filter((e) => e.type.startsWith('admission.'))).toEqual([]);
  });

  /**
   * The test walks the debug workflow to `debug-implement` through the composite handler.
   * On `debug-implement → debug-validate`, the legacy `implementation-complete` guard always passes, but admission needs `implementation.complete === true`.
   * The disposition points at the attempt fact that the store holds for the same edge.
   */
  it('ShadowObserver_Disagreement_EmitsDispositionEvent', async () => {
    const featureId = 'durable-shadow-disposition';

    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'debug' },
      ctx(),
    );
    expect(init.success).toBe(true);

    const steps: ReadonlyArray<
      readonly [Record<string, unknown> | undefined, string]
    > = [
      [{ 'triage.symptom': 'requests fail' }, 'investigate'],
      [{ track: 'thorough' }, 'rca'],
      [{ 'artifacts.rca': 'docs/rca.md' }, 'design'],
      [{ 'artifacts.fixDesign': 'docs/fix.md' }, 'debug-implement'],
    ];
    for (const [updates, target] of steps) {
      if (updates !== undefined) {
        await handleSet({ featureId, updates }, stateDir, eventStore);
      }
      const stepped = await handleWorkflow(
        { action: 'transition', featureId, target },
        ctx(),
      );
      expect(stepped.success, `transition to ${target}`).toBe(true);
    }

    const defect = await handleWorkflow(
      { action: 'transition', featureId, target: 'debug-validate' },
      ctx(),
    );
    expect(defect.success).toBe(true);

    await flushLiveShadowEvidence();

    const dispositions = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.disagreement-disposition',
    });
    expect(dispositions.length).toBe(1);
    const dispositionEvent = dispositions[0]!;
    expect(dispositionEvent.source).toBe('live-shadow-observer');
    const disposition = AdmissionDisagreementDispositionData.parse(
      dispositionEvent.data,
    );
    expect(disposition.disposition).toBe('unexplained');
    expect(disposition.rationale).toContain('live shadow disagreement');

    const attempts = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    const denied = attempts
      .map((persisted) => AdmissionShadowAttemptData.parse(persisted.data))
      .filter((attempt) => attempt.decision.outcome === 'deny');
    expect(denied.length).toBe(1);
    expect(denied[0]!.legacyOutcome).toBe('allow');
    expect(disposition.shadowAttemptId).toBe(denied[0]!.shadowAttemptId);
  });

  /**
   * `recordLiveTransition` sets a new `evaluatedAt` from the real clock on each call.
   * The attempt identity does not hash that instant, so a retry of one observation gives one durable row for each fact.
   * The test uses no pinned clock. It waits 10 ms between the two calls, so the two instants differ.
   * The obsolete-predicate edge makes the test cover both the attempt fact and the disposition fact.
   */
  it('ShadowObserver_RealClockRetry_CollapsesOntoOneDurableRowPerFact', async () => {
    const featureId = 'durable-shadow-retry-realclock';
    const observation: LegacyTransitionObservation = {
      workflowType: 'debug',
      fromPhase: 'debug-implement',
      toPhase: 'debug-validate',
      legacyOutcome: 'allow',
      idempotent: false,
    };
    const state = {
      featureId,
      implementation: { complete: false },
      _pendingPhaseAttemptId: 'pa-retry-current',
    };

    recordLiveTransition(observation, { ...state }, eventStore);
    await flushLiveShadowEvidence();
    await new Promise((resolve) => setTimeout(resolve, 10));
    recordLiveTransition(observation, { ...state }, eventStore);
    await flushLiveShadowEvidence();

    const attempts = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.idempotencyKey).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);

    const dispositions = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.disagreement-disposition',
    });
    expect(dispositions.length).toBe(1);
    expect(dispositions[0]!.idempotencyKey).toMatch(
      /^disagreement-disposition:[0-9a-f]{64}$/,
    );
  });

  /**
   * Production callers stamp the attempt for the observed transition as `_pendingPhaseAttemptId` before `attempt()`.
   * They persist `phaseAttemptId` only after success, so a read of the persisted field names the predecessor attempt.
   * The durable fact and its evidence subject must name the current attempt.
   */
  it('ShadowObserver_PendingAttemptStamped_DurableFactNamesTheCurrentAttempt', async () => {
    const featureId = 'durable-shadow-current-attempt';
    observeLiveTransition(
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'plan-review',
        legacyOutcome: 'allow',
        idempotent: false,
      },
      {
        featureId,
        artifacts: { plan: 'docs/x.md' },
        phaseAttemptId: 'pa-predecessor',
        _pendingPhaseAttemptId: 'pa-current',
      },
      {
        sink: new InMemoryLiveShadowSink(),
        context: CTX,
        health: new LiveShadowHealthCounter(),
        evidence: { appender: eventStore },
      },
    );
    await flushLiveShadowEvidence();

    const persisted = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    expect(persisted.length).toBe(1);
    const data = AdmissionShadowAttemptData.parse(persisted[0]!.data);
    expect(data.phaseAttemptId).toBe('pa-current');
    expect(data.phaseAttemptId).not.toBe('pa-predecessor');
    expect(data.subject.kind).toBe('phase-attempt');
    if (data.subject.kind === 'phase-attempt') {
      expect(data.subject.phaseAttemptId).toBe('pa-current');
    }
  });

  /**
   * The same check runs through `dispatch()`, the entry point that the MCP server calls, with schema validation and the read-only gate.
   * The test does not name the shadow observer.
   */
  it('ShadowObserver_ShippedDispatchPath_EmitsDurableShadowAttempt', async () => {
    const featureId = 'durable-shadow-dispatch';

    const initRes = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(initRes.isError ?? false).toBe(false);
    const updateRes = await dispatch(
      'exarchos_workflow',
      { action: 'update', featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      ctx(),
    );
    expect(updateRes.isError ?? false).toBe(false);
    const transitionRes = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(transitionRes.isError ?? false).toBe(false);

    await flushLiveShadowEvidence();

    const persisted = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    expect(persisted.length).toBe(1);
    const data = AdmissionShadowAttemptData.parse(persisted[0]!.data);
    expect(data.legacyOutcome).toBe('allow');
    expect(data.decision.outcome).toBe('allow');
  });

  /**
   * The HSM primitive must hand `GuardContext.eventStore` to the observer. This test is the narrowest check of that wiring.
   * If `notifyShadowObserver` forwards `null`, this test fails.
   * The test compares identity with the store that it created, not with an observer output.
   */
  it('ShadowObserver_GuardSeam_ForwardsEventStoreFromGuardContext', async () => {
    const guard = new DefaultHSMTransitionGuard();
    const featureId = 'durable-shadow-seam';
    const state = { featureId, phase: 'plan', artifacts: { plan: 'docs/x.md' } };

    const seen: Array<EventStore | null> = [];
    const result = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...state },
      workflowType: 'feature',
      eventStore,
      shadowObserver: (_observation, observerStore) => {
        seen.push(observerStore);
      },
    });

    expect(result.ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(eventStore);
  });

  /** With no store in the guard context, the in-memory cache still fills, but the observer writes no durable fact. */
  it('emits nothing durable when the guard context carries no store', async () => {
    const guard = new DefaultHSMTransitionGuard();
    const featureId = 'durable-shadow-nostore';
    const state = { featureId, phase: 'plan', artifacts: { plan: 'docs/x.md' } };

    await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...state },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: (observation, observerStore) =>
        recordLiveTransition(observation, { ...state }, observerStore),
    });
    await flushLiveShadowEvidence();

    expect(
      await eventStore.query(liveShadowEvidenceStreamId(featureId), { type: 'admission.shadow-attempt' }),
    ).toEqual([]);
    expect(liveShadowSink.size).toBeGreaterThan(0);
  });

  async function driveToInvestigate(featureId: string): Promise<void> {
    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'debug' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await handleSet(
      { featureId, updates: { 'triage.symptom': 'requests fail' } },
      stateDir,
      eventStore,
    );
    const stepped = await handleWorkflow(
      { action: 'transition', featureId, target: 'investigate' },
      ctx(),
    );
    expect(stepped.success).toBe(true);
    await flushLiveShadowEvidence();
  }

  /**
   * `handleCancel` builds its guard context with `eventStore: null` and passes its own store to the observer.
   * Thus a test of the store that `notifyShadowObserver` forwards does not cover this handler.
   * If the handler drops its store argument, the attempt count does not change.
   *
   * The helper walks a `debug` feature to `investigate`, where the shared IR models a guarded `cancelled` edge.
   * From a phase with only the universal `cancelled` edge, the observer records nothing.
   * The helper flushes the evidence of its walk, so only the cancel transition can add the next attempt.
   * No shadow event appears on the feature stream. A fire-and-forget append there can interleave with the trail that `handleCancel` commits atomically.
   */
  it('ShadowObserver_CancelTransition_EmitsDurableShadowAttempt', async () => {
    const featureId = 'durable-shadow-cancel';
    await driveToInvestigate(featureId);

    const before = (
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.shadow-attempt',
      })
    ).length;

    const cancelled = await handleWorkflow(
      { action: 'cancel', featureId, reason: 'shadow evidence regression guard' },
      ctx(),
    );
    expect(cancelled.success).toBe(true);
    await flushLiveShadowEvidence();

    const attempts = await eventStore.query(
      liveShadowEvidenceStreamId(featureId),
      { type: 'admission.shadow-attempt' },
    );
    expect(attempts.length).toBe(before + 1);

    const data = AdmissionShadowAttemptData.parse(attempts.at(-1)!.data);
    expect(attempts.at(-1)!.source).toBe('live-shadow-observer');
    expect(data.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(data.subject.kind).toBe('phase-attempt');

    const authoritative = await eventStore.query(featureId);
    expect(authoritative.length).toBeGreaterThan(0);
    expect(authoritative.filter((e) => e.type.startsWith('admission.'))).toEqual([]);
  });

  /**
   * `handleCleanup` also builds its guard context with `eventStore: null` and passes its own store to the observer.
   * The shared IR models `debug:investigate:completed`, so cleanup reaches a guarded edge.
   * The guard notifies the observer on the allow arm and the deny arm, so the assertion does not depend on cleanup success.
   */
  it('ShadowObserver_CleanupTransition_EmitsDurableShadowAttempt', async () => {
    const featureId = 'durable-shadow-cleanup';
    await driveToInvestigate(featureId);

    const before = (
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.shadow-attempt',
      })
    ).length;

    await handleWorkflow(
      { action: 'cleanup', featureId, mergeVerified: true },
      ctx(),
    );
    await flushLiveShadowEvidence();

    const attempts = await eventStore.query(
      liveShadowEvidenceStreamId(featureId),
      { type: 'admission.shadow-attempt' },
    );
    expect(attempts.length).toBe(before + 1);

    const data = AdmissionShadowAttemptData.parse(attempts.at(-1)!.data);
    expect(attempts.at(-1)!.source).toBe('live-shadow-observer');
    expect(data.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(data.subject.kind).toBe('phase-attempt');

    const authoritative = await eventStore.query(featureId);
    expect(authoritative.length).toBeGreaterThan(0);
    expect(authoritative.filter((e) => e.type.startsWith('admission.'))).toEqual([]);
  });
});

/** A trust directory that is unavailable — the admission engine throws. */
const UNAVAILABLE_AUTHORITY: PolicyAuthority = {
  authorizesGateEvidence(): boolean {
    throw new Error('trust directory unavailable');
  },
  authorizesApproval(): boolean {
    throw new Error('trust directory unavailable');
  },
  authorizesWaiver(): boolean {
    throw new Error('trust directory unavailable');
  },
};

const ERRORING_CTX = { ...CTX, authority: UNAVAILABLE_AUTHORITY };

/**
 * Six shared-IR edges, one for each {@link PhaseKind}.
 * Each edge carries a gate or approval obligation, and its route is always legal.
 * Thus the admission engine consults the trust directory on each edge.
 */
const COVERING_EDGES: ReadonlyArray<{
  readonly edge: Omit<LegacyTransitionObservation, 'legacyOutcome' | 'idempotent'>;
  readonly state: Record<string, unknown>;
}> = [
  {
    edge: { workflowType: 'feature', fromPhase: 'plan', toPhase: 'plan-review' },
    state: { artifacts: { plan: 'docs/specs/x.md' } },
  },
  {
    edge: { workflowType: 'feature', fromPhase: 'plan-review', toPhase: 'delegate' },
    state: { planReview: { approved: true } },
  },
  {
    edge: { workflowType: 'feature', fromPhase: 'delegate', toPhase: 'review' },
    /** The projection derives the task facts from the task array, and `team.disbandedOk` is true when no team was spawned. */
    state: { tasks: [{ status: 'complete' }, { status: 'complete' }] },
  },
  {
    edge: { workflowType: 'feature', fromPhase: 'delegate', toPhase: 'merge-pending' },
    /** The projection derives `mergePending.entryReady` from the last `task.completed` event with a worktree. */
    state: { _events: [{ type: 'task.completed', data: { worktree: 'wt-1' } }] },
  },
  {
    edge: { workflowType: 'feature', fromPhase: 'synthesize', toPhase: 'completed' },
    state: { synthesis: { prUrl: 'https://example.invalid/pr/1' } },
  },
  {
    edge: { workflowType: 'debug', fromPhase: 'triage', toPhase: 'investigate' },
    state: { triage: { symptom: 'requests fail' } },
  },
];

/**
 * {@link MINIMUM_LIVE_ATTEMPTS} observations that cover each phase kind and both outcomes.
 * The legacy verdict is an input to an observation, and it alternates to model a mixed live corpus.
 */
function coveringObservations(featureId: string): ReadonlyArray<{
  readonly observation: LegacyTransitionObservation;
  readonly state: Record<string, unknown>;
}> {
  return Array.from({ length: MINIMUM_LIVE_ATTEMPTS }, (_unused, i) => {
    const fixture = COVERING_EDGES[i % COVERING_EDGES.length]!;
    return {
      observation: {
        ...fixture.edge,
        legacyOutcome: i % 2 === 0 ? ('allow' as const) : ('deny' as const),
        idempotent: false,
      },
      state: { ...fixture.state, featureId, phaseAttemptId: `pa-${i}` },
    };
  });
}

/**
 * Health counters make a dead observer detectable, and the cutover gate counts only comparable attempts toward its live conditions.
 * No test increments a health counter. Each counter reading follows a `dispatch()` or `observeLiveTransition` call, so only production code moves the counters.
 * `failSidecarAppends` rejects only the sidecar appends and leaves the authoritative appends unchanged.
 */
describe('DR-23 / T-32 — observer health + gate soundness', () => {
  let stateDir: string;
  let eventStore: EventStore;

  function ctx() {
    return { stateDir, eventStore, enableTelemetry: false };
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'live-shadow-health-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    liveShadowSink.clear();
    liveShadowHealth.reset();
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    liveShadowSink.clear();
    liveShadowHealth.reset();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  function failSidecarAppends(store: EventStore): () => void {
    const original = store.append.bind(store);
    const patched: EventStore['append'] = async (streamId, event, options) => {
      if (streamId.includes(LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT)) {
        throw new Error('shadow evidence store outage');
      }
      return original(streamId, event, options);
    };
    Object.defineProperty(store, 'append', {
      value: patched,
      configurable: true,
      writable: true,
    });
    return () => {
      Reflect.deleteProperty(store, 'append');
    };
  }

  /**
   * The test drives `dispatch()` over a store whose shadow-evidence appends reject, and it does not touch the counter.
   * The evidence outage does not fail the transition. The counter reports the lost appends, and the observer status is `dead`.
   * The sidecar stream is empty, so only the counter shows that the observer is dead and not quiet.
   */
  it('ShadowObserver_SinkThrows_IncrementsHealthCounter', async () => {
    const featureId = 'shadow-health-sink-throws';
    const restore = failSidecarAppends(eventStore);
    try {
      const init = await dispatch(
        'exarchos_workflow',
        { action: 'init', featureId, workflowType: 'feature' },
        ctx(),
      );
      expect(init.isError ?? false).toBe(false);
      const updated = await dispatch(
        'exarchos_workflow',
        {
          action: 'update',
          featureId,
          updates: { 'artifacts.plan': 'docs/specs/x.md' },
        },
        ctx(),
      );
      expect(updated.isError ?? false).toBe(false);

      const transition = await dispatch(
        'exarchos_workflow',
        { action: 'transition', featureId, target: 'plan-review' },
        ctx(),
      );
      expect(transition.isError ?? false).toBe(false);

      await flushLiveShadowEvidence();
    } finally {
      restore();
    }

    const health = liveShadowHealth.snapshot();
    expect(health.attemptsObserved).toBeGreaterThan(0);
    expect(health.appendsScheduled).toBeGreaterThan(0);
    expect(health.appendsFailed).toBeGreaterThan(0);
    expect(health.appendsSucceeded).toBe(0);
    expect(liveShadowObserverStatus(health)).toBe('dead');

    expect(
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.shadow-attempt',
      }),
    ).toEqual([]);
  });

  /** The drive matches the failing-store test, with a working store. Without this test, a counter that always increments satisfies `appendsFailed > 0`. */
  it('ShadowObserver_HealthyStore_CountsLandedAppendsAndStaysHealthy', async () => {
    const featureId = 'shadow-health-healthy';
    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.isError ?? false).toBe(false);
    await dispatch(
      'exarchos_workflow',
      {
        action: 'update',
        featureId,
        updates: { 'artifacts.plan': 'docs/specs/x.md' },
      },
      ctx(),
    );
    await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    await flushLiveShadowEvidence();

    const health = liveShadowHealth.snapshot();
    expect(health.attemptsObserved).toBeGreaterThan(0);
    expect(health.appendsSucceeded).toBeGreaterThan(0);
    expect(health.appendsFailed).toBe(0);
    expect(health.observationsThrew).toBe(0);
    expect(health.streamUnresolved).toBe(0);
    expect(liveShadowObserverStatus(health)).toBe('healthy');
  });

  /** A throwing in-memory sink moves only the `observationsThrew` field. `appendsFailed` does not change. */
  it('ShadowObserver_ObservationThrows_IncrementsThrewCounterAlone', async () => {
    const health = new LiveShadowHealthCounter();
    const throwingSink = {
      record(): void {
        throw new Error('sink boom');
      },
    };
    observeLiveTransition(
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'plan-review',
        legacyOutcome: 'allow',
        idempotent: false,
      },
      { featureId: 'shadow-health-threw', artifacts: { plan: 'docs/x.md' } },
      { sink: throwingSink, context: CTX, health },
    );

    const snapshot = health.snapshot();
    expect(snapshot.observationsThrew).toBe(1);
    expect(snapshot.attemptsObserved).toBe(1);
    expect(snapshot.appendsFailed).toBe(0);
    expect(snapshot.appendsScheduled).toBe(0);
    expect(snapshot.streamUnresolved).toBe(0);
    expect(liveShadowObserverStatus(snapshot)).toBe('dead');
  });

  /**
   * A state without `featureId` has no evidence stream. This condition counts as a dead observer, and only the `streamUnresolved` field moves.
   * The in-memory cache still records the attempt, but the durable stream holds nothing.
   */
  it('ShadowObserver_UnresolvableStream_IncrementsUnresolvedCounterAlone', async () => {
    const health = new LiveShadowHealthCounter();
    const sink = new InMemoryLiveShadowSink();
    observeLiveTransition(
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'plan-review',
        legacyOutcome: 'allow',
        idempotent: false,
      },
      { artifacts: { plan: 'docs/x.md' } },
      { sink, context: CTX, health, evidence: { appender: eventStore } },
    );
    await flushLiveShadowEvidence();

    const snapshot = health.snapshot();
    expect(snapshot.streamUnresolved).toBe(1);
    expect(snapshot.attemptsObserved).toBe(1);
    expect(snapshot.appendsScheduled).toBe(0);
    expect(snapshot.appendsFailed).toBe(0);
    expect(snapshot.observationsThrew).toBe(0);
    expect(sink.size).toBe(1);
  });

  /** A dead observer must not read as a quiet one. */
  it('ShadowObserver_DeadAndQuietObservers_AreDifferentReadings', () => {
    expect(liveShadowObserverStatus(ZERO_LIVE_SHADOW_HEALTH)).toBe('unobserved');
    expect(
      liveShadowObserverStatus({
        ...ZERO_LIVE_SHADOW_HEALTH,
        attemptsObserved: 20,
        appendsScheduled: 20,
        appendsFailed: 20,
      }),
    ).toBe('dead');
    expect(
      liveShadowObserverStatus({
        ...ZERO_LIVE_SHADOW_HEALTH,
        attemptsObserved: 20,
        appendsScheduled: 20,
        appendsSucceeded: 19,
        appendsFailed: 1,
      }),
    ).toBe('degraded');
  });

  function cleanCorpus(): ShadowDecisionRecord[] {
    return [
      {
        attempt: {
          workflowType: 'feature',
          fromPhase: 'a',
          toPhase: 'b',
          phaseKind: 'IMPLEMENT',
        },
        legacyOutcome: 'allow',
        admission: { status: 'evaluated', verdict: 'allow' },
        disagreementClass: 'agree',
        disposition: 'agree',
        explained: true,
        reason: 'agree',
      },
    ];
  }

  async function driveCoveringAttempts(
    featureId: string,
    context: typeof CTX,
  ): Promise<{ sink: InMemoryLiveShadowSink; health: LiveShadowHealthCounter }> {
    const sink = new InMemoryLiveShadowSink();
    const health = new LiveShadowHealthCounter();
    for (const { observation, state } of coveringObservations(featureId)) {
      observeLiveTransition(observation, state, {
        sink,
        context,
        health,
        evidence: { appender: eventStore },
      });
    }
    await flushLiveShadowEvidence();
    return { sink, health };
  }

  /**
   * The trust directory is unavailable, so each adjudication throws, and the production classifier assigns `shadow-error`.
   * The clean corpus holds nothing unexplained, so only the live conditions can block.
   * The test reads `durableAttempts` from the durable sidecar stream, not from the in-memory buffer.
   * The attempts cover each phase kind and both legacy outcomes, and the observer is healthy. The gate still blocks, because no attempt is comparable.
   */
  it('CutoverGate_AllAttemptsErrored_DoesNotSatisfyLiveConditions', async () => {
    const featureId = 'cutover-all-errored';
    const { sink, health } = await driveCoveringAttempts(featureId, ERRORING_CTX);

    expect(sink.size).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(
      sink.decisionRecords().every((r) => r.admission.status === 'error'),
    ).toBe(true);

    const durableAttempts = await readDurableShadowAttempts(eventStore, [featureId]);
    expect(durableAttempts.length).toBe(MINIMUM_LIVE_ATTEMPTS);

    const report = evaluateCutoverGate({
      corpusRecords: cleanCorpus(),
      liveAttempts: sink.liveAttempts(),
      durableAttempts,
      observerHealth: health.snapshot(),
    });

    expect(report.liveAttemptCount).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(
      new Set(sink.liveAttempts().map((a) => a.phaseKind)),
    ).toEqual(new Set(ALL_PHASE_KINDS));
    expect(new Set(sink.liveAttempts().map((a) => a.outcome))).toEqual(
      new Set(['allow', 'deny']),
    );
    expect(report.observerStatus).toBe('healthy');

    expect(report.satisfied).toBe(false);
    expect(report.comparableLiveAttemptCount).toBe(0);
    expect(report.liveDisagreementClasses['shadow-error']).toBe(
      MINIMUM_LIVE_ATTEMPTS,
    );
    expect(report.durableDisagreementClasses['admission-indeterminate']).toBe(
      MINIMUM_LIVE_ATTEMPTS,
    );
    expect(new Set(report.unmet)).toEqual(
      new Set([
        'live-attempt-threshold',
        'phase-kind-coverage',
        'outcome-coverage',
        'live-disagreement-class',
      ]),
    );
  });

  /** The same edges and driver run with a working admission engine. If no input satisfies the gate, the errored-attempts test proves nothing. */
  it('CutoverGate_ComparableAttempts_SatisfyLiveConditions', async () => {
    const featureId = 'cutover-all-comparable';
    const { sink, health } = await driveCoveringAttempts(featureId, CTX);

    expect(
      sink.decisionRecords().every((r) => r.admission.status === 'evaluated'),
    ).toBe(true);

    const durableAttempts = await readDurableShadowAttempts(eventStore, [featureId]);
    const report = evaluateCutoverGate({
      corpusRecords: cleanCorpus(),
      liveAttempts: sink.liveAttempts(),
      durableAttempts,
      observerHealth: health.snapshot(),
    });

    expect(report.comparableLiveAttemptCount).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(report.nonComparableDurableAttemptCount).toBe(0);
    expect(report.observerStatus).toBe('healthy');
    expect(report.unmet).toEqual([]);
    expect(report.satisfied).toBe(true);
  });

  /** Comparable in-memory attempts whose durable evidence never lands do not satisfy the gate. The health counter is part of the gate decision. */
  it('CutoverGate_DeadObserver_CannotPresentAsCleanEvidence', async () => {
    const featureId = 'cutover-dead-observer';
    const restore = failSidecarAppends(eventStore);
    let sink: InMemoryLiveShadowSink;
    let health: LiveShadowHealthCounter;
    try {
      ({ sink, health } = await driveCoveringAttempts(featureId, CTX));
    } finally {
      restore();
    }

    const durableAttempts = await readDurableShadowAttempts(eventStore, [featureId]);
    expect(durableAttempts).toEqual([]);

    const report = evaluateCutoverGate({
      corpusRecords: cleanCorpus(),
      liveAttempts: sink.liveAttempts(),
      durableAttempts,
      observerHealth: health.snapshot(),
    });

    expect(report.comparableLiveAttemptCount).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(report.observerStatus).toBe('dead');
    expect(report.satisfied).toBe(false);
    expect(new Set(report.unmet)).toEqual(
      new Set(['live-disagreement-class', 'live-observer-health']),
    );
  });

  /** The authoritative feature stream carries no `admission.` events, so a reader that points at it returns nothing. */
  it('CutoverGate_ReadsTheSidecarStream_NotTheAuthoritativeOne', async () => {
    const featureId = 'cutover-sidecar-read';
    await driveCoveringAttempts(featureId, CTX);

    const fromSidecar = await readDurableShadowAttempts(eventStore, [featureId]);
    expect(fromSidecar.length).toBe(MINIMUM_LIVE_ATTEMPTS);

    const authoritative = await eventStore.query(featureId);
    expect(authoritative.filter((e) => e.type.startsWith('admission.'))).toEqual(
      [],
    );
  });
});
