// ─── P07-02 exit-proof (c) — live shadow observer records without altering prod ─
//
// The live observer must accumulate the cutover-gate evidence substrate (phase
// kind + outcome, plus a typed shadow decision) WITHOUT changing any production
// behaviour. These tests pin: (1) the observer records guarded-edge attempts and
// skips unmodelled edges; (2) it classifies a known legacy defect as a
// legacy-allow / admission-deny disagreement; (3) it is fully error-isolated;
// and (4) wired through the real guard, the transition result is byte-identical
// to the unobserved path while the sink still accumulates an attempt.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultHSMTransitionGuard } from '../hsm-transition-guard.js';
import { defaultTranslationContext } from './legacy-state-translation.js';
import { EventStore } from '../../events/store.js';
import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
} from '../../events/schemas.js';
import { handleWorkflow } from '../composite.js';
import { handleSet } from '../tools.js';
import { dispatch } from '../../dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
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
} from './live-shadow-observer.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  evaluateCutoverGate,
  readDurableShadowAttempts,
} from './cutover-gate.js';
import type { PolicyAuthority } from './policy-authority.js';
import type {
  LegacyTransitionObservation,
  ShadowDecisionRecord,
} from './shadow-decision.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

function deps(
  sink: InMemoryLiveShadowSink,
  health = new LiveShadowHealthCounter(),
) {
  return { sink, context: CTX, health };
}

describe('observeLiveTransition — records the cutover-gate substrate', () => {
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
    // legacy allow + admission allow (plan present) → agreement
    expect(sink.decisionRecords()[0]?.disagreementClass).toBe('agree');
  });

  it('classifies a known legacy defect as legacy-allow / admission-deny (unexplained)', () => {
    const sink = new InMemoryLiveShadowSink();
    observeLiveTransition(
      {
        workflowType: 'debug',
        fromPhase: 'debug-implement',
        toPhase: 'debug-validate',
        legacyOutcome: 'allow', // legacy `implementation-complete` always passes
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

  it('skips an unmodelled edge (no shared-IR entry) without recording', () => {
    const sink = new InMemoryLiveShadowSink();
    observeLiveTransition(
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'cancelled', // universal edge, not a guarded IR edge
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

// ─── DR-23 / T-31 — durable shadow evidence emitted FROM PRODUCTION ──────────
//
// The audit finding these tests answer: `liveShadowSink` was a process-scoped
// in-memory ring buffer and the two registered replay shapes
// (`admission.shadow-attempt` / `admission.disagreement-disposition`) had no
// producer at all. Reading the in-memory buffer back would therefore prove
// nothing. Every assertion below is made against an event READ BACK OUT of a
// real file-backed `EventStore`, after driving a REAL transition through the
// production `exarchos_workflow` composite handler — not against the payload
// object handed to `append`.
//
// ANTI-VACUITY, one level up: nothing in this file connects the observer to
// the store. The tests supply only a `DispatchContext.eventStore`, which is the
// ordinary production dispatch contract every tool already receives. The path
// `ctx.eventStore` → `handleSet` → `GuardContext.eventStore` →
// `notifyShadowObserver` → `recordLiveTransition` is ENTIRELY production code.
// Make `notifyShadowObserver` forward `null` and these tests go red.

describe('DR-23 / T-31 — durable shadow evidence from the production path', () => {
  let stateDir: string;
  let eventStore: EventStore;

  function ctx() {
    return { stateDir, eventStore, enableTelemetry: false };
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'live-shadow-durable-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    liveShadowSink.clear();
    // NOTHING is bound or injected here. The observer must obtain its durable
    // substrate from production wiring alone.
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    liveShadowSink.clear();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

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

    // The live path: the real composite handler → handleSet → the real HSM
    // guard → `GuardContext.shadowObserver` → `recordLiveTransition`.
    const transition = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(transition.success).toBe(true);

    await flushLiveShadowEvidence();

    // ── Read the fact back OUT of the store. ──────────────────────────────
    const persisted = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    expect(persisted.length).toBe(1);
    const event = persisted[0]!;
    expect(event.type).toBe('admission.shadow-attempt');
    expect(event.source).toBe('live-shadow-observer');

    // Re-validate the PERSISTED bytes against the registered schema — the event
    // has round-tripped through JSONL, so this is not the object we appended.
    const data = AdmissionShadowAttemptData.parse(event.data);
    expect(data.legacyOutcome).toBe('allow');
    expect(data.subject.kind).toBe('phase-attempt');
    expect(data.decision.outcome).toBe('allow');
    // Natural (non-random) identity — a pure function of the observed attempt.
    expect(data.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(data.caller.principalKind).toBe('service');

    // T-31: the durable fact names the CURRENT attempt — the one this very
    // transition allocated (stamped `_pendingPhaseAttemptId` pre-attempt and
    // persisted as `phaseAttemptId` post-success) — never the predecessor
    // attempt that was sitting in `phaseAttemptId` when the observer ran.
    const persistedState = JSON.parse(
      await readFile(join(stateDir, `${featureId}.state.json`), 'utf-8'),
    ) as Record<string, unknown>;
    expect(persistedState.phaseAttemptId).toBeDefined();
    expect(data.phaseAttemptId).toBe(persistedState.phaseAttemptId);

    // An AGREEMENT has nothing to dispose of: the disposition enum has no
    // `agree` member, so no disposition fact may be written for this attempt.
    expect(
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.disagreement-disposition',
      }),
    ).toEqual([]);

    // ── The observer must not perturb the AUTHORITATIVE stream. ───────────
    // Shadow evidence is non-authoritative and appended fire-and-forget; on the
    // feature's own stream it would interleave at a nondeterministic sequence
    // and could race the CAS writes in `handleSet`. Nothing shadow-shaped may
    // appear there.
    const authoritative = await eventStore.query(featureId);
    expect(authoritative.length).toBeGreaterThan(0);
    expect(authoritative.filter((e) => e.type.startsWith('admission.'))).toEqual([]);
  });

  it('ShadowObserver_Disagreement_EmitsDispositionEvent', async () => {
    const featureId = 'durable-shadow-disposition';

    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'debug' },
      ctx(),
    );
    expect(init.success).toBe(true);

    // Walk the real debug workflow to `debug-implement` through the production
    // composite handler. Every step is a legacy-authoritative transition.
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

    // `debug-implement` → `debug-validate` is the P06-01 obsolete predicate:
    // the legacy `implementation-complete` guard ALWAYS passes, while admission
    // requires `implementation.complete === true`. Legacy allow / admission deny.
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

    // Cross-event linkage, read from a SECOND independent store read: the
    // disposition must point at the attempt fact persisted for the same edge.
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

  it('ShadowObserver_RealClockRetry_CollapsesOntoOneDurableRowPerFact', async () => {
    // T-49 — the production binding `recordLiveTransition` mints a FRESH
    // `evaluatedAt: new Date().toISOString()` on every call. The attempt
    // identity therefore must NOT hash the evaluation instant: a genuine retry
    // of one logical observation would otherwise derive a fresh key and
    // DUPLICATE both durable facts. Deliberately NO pinned clock here — the
    // whole point is that two real-clock invocations, wall-clock apart, still
    // collapse. (The P06-01 obsolete-predicate edge is used so BOTH facts —
    // attempt AND disagreement disposition — are exercised.)
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
    // Force the wall clock forward so the retry's `evaluatedAt` is provably
    // different — a hash that still included it would mint a second key.
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

  it('ShadowObserver_PendingAttemptStamped_DurableFactNamesTheCurrentAttempt', async () => {
    // T-31 — every production caller (tools.ts / cleanup.ts / cancel.ts)
    // stamps the attempt allocated for the OBSERVED transition as
    // `_pendingPhaseAttemptId` before `attempt()` and only persists
    // `phaseAttemptId` after success. Reading the persisted field first would
    // label every durable shadow fact with the PREDECESSOR attempt.
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
    // The evidence subject names the same attempt.
    expect(data.subject.kind).toBe('phase-attempt');
    if (data.subject.kind === 'phase-attempt') {
      expect(data.subject.phaseAttemptId).toBe('pa-current');
    }
  });

  it('ShadowObserver_ShippedDispatchPath_EmitsDurableShadowAttempt', async () => {
    // The same proof, one layer further out: through `dispatch()` — the exact
    // entry point the MCP server calls, including schema validation and the
    // read-only gate. Nothing here mentions the shadow observer at all.
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

  it('ShadowObserver_GuardSeam_ForwardsEventStoreFromGuardContext', async () => {
    // The narrowest possible pin on the production wiring: the HSM primitive
    // must hand `GuardContext.eventStore` to the observer. Without this, the
    // observer has no substrate and DR-23 bullet 1 is unclosed. Neuter
    // `notifyShadowObserver` to forward `null` and this test fails alone.
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
    // Identity against the store THIS TEST created and handed to the guard
    // context — not against anything the observer produced.
    expect(seen[0]).toBe(eventStore);
  });

  it('emits nothing durable when the guard context carries no store', async () => {
    // The degradation branch (`cancel`/`cleanup`-style pure evaluation with a
    // genuinely absent store): the in-memory cache still fills, but no durable
    // fact is written. This is the only remaining memory-only mode.
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
    // ...but the in-memory cache still saw it, proving the transition really ran.
    expect(liveShadowSink.size).toBeGreaterThan(0);
  });

  // ─── The other two production emission sites ──────────────────────────────
  //
  // `tools.ts` reads the store FORWARDED by `notifyShadowObserver`, so the
  // forward-severing probe guards it. `cancel.ts` / `cleanup.ts` deliberately
  // build their guard context with `eventStore: null` (pure-evaluation mode —
  // those handlers own authoritative emission so their trails commit atomically
  // via `appendTrailAtomically`) and hand the observer their OWN lexical store
  // instead. Forwarding the context's `null` would silently disable durable
  // evidence on both paths, so the forward probe cannot reach them. These two
  // tests are their dedicated regression guard: delete either handler's
  // `shadowObserver` and exactly one of them goes red.
  //
  // Both drive `debug` to `investigate`, from which the shared IR models BOTH
  // `debug:investigate:cancelled` (route-condition, `investigation.escalate`)
  // and `debug:investigate:completed` (admission-requirement) — so each handler
  // reaches a real guarded edge rather than an unmodelled universal one.

  /** Init a `debug` feature and walk it to `investigate` via production. */
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
    // Drain the evidence the walk itself produced so the delta assertions below
    // can only be satisfied by the cancel/cleanup transition.
    await flushLiveShadowEvidence();
  }

  it('ShadowObserver_CancelTransition_EmitsDurableShadowAttempt', async () => {
    const featureId = 'durable-shadow-cancel';
    await driveToInvestigate(featureId);

    const before = (
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.shadow-attempt',
      })
    ).length;

    // The real production cancel handler, through the composite entry point.
    const cancelled = await handleWorkflow(
      { action: 'cancel', featureId, reason: 'shadow evidence regression guard' },
      ctx(),
    );
    expect(cancelled.success).toBe(true);
    await flushLiveShadowEvidence();

    // `handleCancel` builds its guard context with `eventStore: null` and passes
    // its OWN store to the observer. If that argument is dropped, this is 0.
    const attempts = await eventStore.query(
      liveShadowEvidenceStreamId(featureId),
      { type: 'admission.shadow-attempt' },
    );
    expect(attempts.length).toBe(before + 1);

    const data = AdmissionShadowAttemptData.parse(attempts.at(-1)!.data);
    expect(attempts.at(-1)!.source).toBe('live-shadow-observer');
    expect(data.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(data.subject.kind).toBe('phase-attempt');

    // The OCC hazard that motivated the sidecar would surface HERE first:
    // `handleCancel` commits its authoritative trail atomically, and a
    // fire-and-forget shadow append on that same stream could interleave.
    const authoritative = await eventStore.query(featureId);
    expect(authoritative.length).toBeGreaterThan(0);
    expect(authoritative.filter((e) => e.type.startsWith('admission.'))).toEqual([]);
  });

  it('ShadowObserver_CleanupTransition_EmitsDurableShadowAttempt', async () => {
    const featureId = 'durable-shadow-cleanup';
    await driveToInvestigate(featureId);

    const before = (
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.shadow-attempt',
      })
    ).length;

    // The real production cleanup handler: `investigate` → `completed`.
    await handleWorkflow(
      { action: 'cleanup', featureId, mergeVerified: true },
      ctx(),
    );
    await flushLiveShadowEvidence();

    // Emitted on BOTH the allow and deny arms of the guard — the observer is
    // notified regardless of the legacy verdict — so this assertion does not
    // depend on cleanup succeeding, only on the observer being wired.
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

// ─── DR-23 / T-32 — a DEAD observer is detectable, and the gate is sound ──────
//
// DR-23's remaining two bullets. The audit found (a) every shadow failure was
// swallowed into an indistinguishable silence — "zero shadow evidence because
// nothing happened" read exactly like "zero shadow evidence because every
// append rejected"; and (b) the cutover gate's live conditions read only the
// LEGACY verdict, so "20 attempts that all threw would satisfy three of four
// conditions".
//
// ANTI-VACUITY, stated up front: not one assertion below increments a counter
// itself. Every health reading is taken AFTER driving a real transition (through
// `dispatch()` where possible, otherwise through the production
// `observeLiveTransition`) against a store or an admission authority that is
// rigged to FAIL — so the counters can only move if production moves them. The
// errored-attempt fixtures are likewise PRODUCED: the classes are assigned by
// the production classifier from a real adjudication that really threw, never
// written into a literal.

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
 * Six REAL shared-IR edges — one per {@link PhaseKind} — each carrying a gate or
 * approval obligation on an unconditionally legal route, so the admission engine
 * genuinely consults the trust directory on every one of them.
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
    // `tasks.count` / `tasks.allComplete` are PROJECTED from the real task
    // array, and `team.disbandedOk` is vacuously true when no team was spawned,
    // so this state genuinely satisfies the edge's obligation.
    state: { tasks: [{ status: 'complete' }, { status: 'complete' }] },
  },
  {
    edge: { workflowType: 'feature', fromPhase: 'delegate', toPhase: 'merge-pending' },
    // `mergePending.entryReady` is projected from the last `task.completed`
    // event carrying a worktree — not from a state flag.
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

/** {@link MINIMUM_LIVE_ATTEMPTS} observations: every phase kind, both outcomes. */
function coveringObservations(featureId: string): ReadonlyArray<{
  readonly observation: LegacyTransitionObservation;
  readonly state: Record<string, unknown>;
}> {
  return Array.from({ length: MINIMUM_LIVE_ATTEMPTS }, (_unused, i) => {
    const fixture = COVERING_EDGES[i % COVERING_EDGES.length]!;
    return {
      observation: {
        ...fixture.edge,
        // The LEGACY verdict is an INPUT to an observation (the legacy guard has
        // already decided); alternating it is what a mixed live corpus looks
        // like, and it is what gave the pre-T-32 gate its outcome coverage.
        legacyOutcome: i % 2 === 0 ? ('allow' as const) : ('deny' as const),
        idempotent: false,
      },
      state: { ...fixture.state, featureId, phaseAttemptId: `pa-${i}` },
    };
  });
}

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

  /**
   * Rig the SIDECAR evidence appends to reject, leaving every authoritative
   * append untouched. This is a store outage as production would meet one.
   */
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

  it('ShadowObserver_SinkThrows_IncrementsHealthCounter', async () => {
    // The named acceptance test. NOTHING here touches the counter: the whole
    // drive is `dispatch()` — the shipped MCP entry point — over a store whose
    // shadow-evidence appends reject. The health reading afterwards is whatever
    // PRODUCTION recorded.
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
      // NON-AUTHORITATIVE: the evidence outage must not fail the transition.
      expect(transition.isError ?? false).toBe(false);

      await flushLiveShadowEvidence();
    } finally {
      restore();
    }

    const health = liveShadowHealth.snapshot();
    expect(health.attemptsObserved).toBeGreaterThan(0);
    expect(health.appendsScheduled).toBeGreaterThan(0);
    // The evidence really was LOST — and the counter says so.
    expect(health.appendsFailed).toBeGreaterThan(0);
    expect(health.appendsSucceeded).toBe(0);
    expect(liveShadowObserverStatus(health)).toBe('dead');

    // Corroboration from the substrate itself: the sidecar stream is empty. A
    // reader that only looked here would see "no disagreements"; the counter is
    // what makes that reading attributable to a dead observer.
    expect(
      await eventStore.query(liveShadowEvidenceStreamId(featureId), {
        type: 'admission.shadow-attempt',
      }),
    ).toEqual([]);
  });

  it('ShadowObserver_HealthyStore_CountsLandedAppendsAndStaysHealthy', async () => {
    // The positive twin of the test above, byte-for-byte the same drive with a
    // WORKING store. Without it, "appendsFailed > 0" could be satisfied by a
    // counter that increments unconditionally.
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

  it('ShadowObserver_ObservationThrows_IncrementsThrewCounterAlone', async () => {
    // Independence (i): kill the in-memory record path and ONLY the
    // observation-threw field moves. `appendsFailed` must not ride on it.
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

  it('ShadowObserver_UnresolvableStream_IncrementsUnresolvedCounterAlone', async () => {
    // Independence (ii): a state with no `featureId` has nowhere to put its
    // evidence. That is a dead observer, not an absence of activity — and it
    // must move ONLY the unresolved-stream field.
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
      { artifacts: { plan: 'docs/x.md' } }, // no featureId → unresolvable stream
      { sink, context: CTX, health, evidence: { appender: eventStore } },
    );
    await flushLiveShadowEvidence();

    const snapshot = health.snapshot();
    expect(snapshot.streamUnresolved).toBe(1);
    expect(snapshot.attemptsObserved).toBe(1);
    expect(snapshot.appendsScheduled).toBe(0);
    expect(snapshot.appendsFailed).toBe(0);
    expect(snapshot.observationsThrew).toBe(0);
    // The in-memory cache still saw it — which is exactly the ambiguity DR-23
    // names: memory says "observed", the durable stream says "nothing".
    expect(sink.size).toBe(1);
  });

  it('ShadowObserver_DeadAndQuietObservers_AreDifferentReadings', () => {
    // The bullet, stated directly: a dead observer must not read as a quiet one.
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

  // ─── The gate ──────────────────────────────────────────────────────────────

  /** A deterministic corpus with nothing unexplained, so ONLY live conditions bite. */
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

  /** Drive 20 real observations through the production observer. */
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

  it('CutoverGate_AllAttemptsErrored_DoesNotSatisfyLiveConditions', async () => {
    const featureId = 'cutover-all-errored';
    // Every adjudication genuinely THROWS: the trust directory the admission
    // engine consults is unavailable. Nothing below writes a `shadow-error`
    // class — the production classifier assigns it.
    const { sink, health } = await driveCoveringAttempts(featureId, ERRORING_CTX);

    expect(sink.size).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(
      sink.decisionRecords().every((r) => r.admission.status === 'error'),
    ).toBe(true);

    // The gate reads the DURABLE sidecar stream, not the process-scoped buffer.
    const durableAttempts = await readDurableShadowAttempts(eventStore, [featureId]);
    expect(durableAttempts.length).toBe(MINIMUM_LIVE_ATTEMPTS);

    const report = evaluateCutoverGate({
      corpusRecords: cleanCorpus(),
      liveAttempts: sink.liveAttempts(),
      durableAttempts,
      observerHealth: health.snapshot(),
    });

    // The audited premise HOLDS: 20 attempts accrued, every phase kind was
    // exercised and both legacy outcomes are present…
    expect(report.liveAttemptCount).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(
      new Set(sink.liveAttempts().map((a) => a.phaseKind)),
    ).toEqual(new Set(ALL_PHASE_KINDS));
    expect(new Set(sink.liveAttempts().map((a) => a.outcome))).toEqual(
      new Set(['allow', 'deny']),
    );
    // …and the observer was HEALTHY, so nothing below is attributable to a dead
    // observer. The gate blocks purely on the disagreement class.
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

  it('CutoverGate_ComparableAttempts_SatisfyLiveConditions', async () => {
    // The positive twin: the SAME twenty edges, the SAME driver, the only
    // difference being that the admission engine actually works. If the gate
    // were un-satisfiable by construction the test above would prove nothing.
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

  it('CutoverGate_DeadObserver_CannotPresentAsCleanEvidence', async () => {
    // The health counter is LOAD-BEARING on the gate, not merely observable:
    // twenty perfectly comparable in-memory attempts whose durable evidence
    // never landed must not satisfy it.
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

    // In memory everything looks perfect — that is precisely the trap.
    expect(report.comparableLiveAttemptCount).toBe(MINIMUM_LIVE_ATTEMPTS);
    expect(report.observerStatus).toBe('dead');
    expect(report.satisfied).toBe(false);
    expect(new Set(report.unmet)).toEqual(
      new Set(['live-disagreement-class', 'live-observer-health']),
    );
  });

  it('CutoverGate_ReadsTheSidecarStream_NotTheAuthoritativeOne', async () => {
    // Pins WHERE the durable evidence is read from. The authoritative feature
    // stream carries no `admission.*` events (T-31 sidecar purity), so a reader
    // pointed at it returns nothing at all.
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
