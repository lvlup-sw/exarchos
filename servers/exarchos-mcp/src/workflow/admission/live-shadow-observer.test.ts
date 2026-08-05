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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultHSMTransitionGuard } from '../hsm-transition-guard.js';
import { defaultTranslationContext } from './legacy-state-translation.js';
import { EventStore } from '../../event-store/store.js';
import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
} from '../../event-store/schemas.js';
import { handleWorkflow } from '../composite.js';
import { handleSet } from '../tools.js';
import { dispatch } from '../../core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import {
  InMemoryLiveShadowSink,
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  observeLiveTransition,
  recordLiveTransition,
  liveShadowSink,
  type LiveShadowObservationRecord,
} from './live-shadow-observer.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

function deps(sink: InMemoryLiveShadowSink) {
  return { sink, context: CTX };
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
    expect(sink.liveAttempts()[0]).toEqual({ phaseKind: 'PLAN', outcome: 'allow' });
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
    expect(sink.liveAttempts()[0]).toEqual({ phaseKind: 'REVIEW', outcome: 'allow' });
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
        { sink: throwingSink, context: CTX },
      ),
    ).not.toThrow();
  });
});

describe('InMemoryLiveShadowSink — bounded accumulation', () => {
  it('drops the oldest record beyond capacity', () => {
    const sink = new InMemoryLiveShadowSink(2);
    const mk = (i: number): LiveShadowObservationRecord => ({
      attempt: { phaseKind: 'PLAN', outcome: 'allow' },
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
