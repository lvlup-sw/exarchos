// ─── P07-02 exit-proof (c) — live shadow observer records without altering prod ─
//
// The live observer must accumulate the cutover-gate evidence substrate (phase
// kind + outcome, plus a typed shadow decision) WITHOUT changing any production
// behaviour. These tests pin: (1) the observer records guarded-edge attempts and
// skips unmodelled edges; (2) it classifies a known legacy defect as a
// legacy-allow / admission-deny disagreement; (3) it is fully error-isolated;
// and (4) wired through the real guard, the transition result is byte-identical
// to the unobserved path while the sink still accumulates an attempt.

import { describe, expect, it, beforeEach } from 'vitest';

import { DefaultHSMTransitionGuard } from '../hsm-transition-guard.js';
import { defaultTranslationContext } from './legacy-state-translation.js';
import {
  InMemoryLiveShadowSink,
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
      shadowObserver: (o) => recordLiveTransition(o, { ...state }),
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
      shadowObserver: (o) => recordLiveTransition(o, { ...state }),
    });
    expect(liveShadowSink.size).toBe(1);
    expect(liveShadowSink.liveAttempts()[0]).toEqual({
      phaseKind: 'PLAN',
      outcome: 'allow',
    });
  });
});
