/**
 * The emission verifier's lifecycle axis.
 *
 * The missing-events half is pinned beside the dispatch chain it is installed
 * in. This file owns the other half: registration says whether anything emits
 * an event at all, and runtime can contradict it.
 */

import { describe, it, expect } from 'vitest';
import type { EventRegistration } from '../../../../src/events/event-registration.js';
import {
  lifecycleViolations,
  summarizeEmissionRun,
  verifierDeclaredEmissions,
  verifyDeclaredEmissions,
  type EmissionVerdict,
} from '../../../../src/dispatch/core/interceptors/emission-verifier.js';

/**
 * A hand-built registration table. The live catalog is not the subject here —
 * a test that reached for it would change its own meaning every time an event
 * was registered, and could not state a `planned` case at all without waiting
 * for one to exist.
 */
const ANNOTATIONS: Readonly<Record<string, EventRegistration>> = Object.freeze({
  'workflow.started': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'stack.restacked': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['synthesis-readiness'],
  },
  'merge.rollback': {
    lifecycle: 'retired',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
} as Readonly<Record<string, EventRegistration>>);

describe('EmissionVerifier lifecycle axis', () => {
  it('LifecycleVerifier_DeclaredRetiredEvent_FailsAction', () => {
    // The missing-events half is kept in full — `workflow.started` landed. The
    // fault is that the action ALSO declares two edges whose registrations say
    // nothing emits them, and it emitted them anyway.
    const verdict = verifyDeclaredEmissions({
      declared: [
        { event: 'workflow.started', condition: 'always' },
        { event: 'merge.rollback', condition: 'always' },
        { event: 'stack.restacked', condition: 'conditional' },
      ],
      streamId: 'feature-x',
      landed: ['workflow.started', 'stack.restacked', 'merge.rollback'],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('violated');
    expect(verdict.missingEvents).toEqual([]);
    // A conditional edge is never REQUIRED, and it is still the action's own
    // drift once it lands against a registration that emits nothing.
    expect(verdict.lifecycleViolations).toEqual([
      { event: 'merge.rollback', lifecycle: 'retired' },
      { event: 'stack.restacked', lifecycle: 'planned' },
    ]);
  });

  it('LifecycleVerifier_UnrelatedOperationEvent_DoesNotFailAction', () => {
    // An operation id is a shared join key. These two landings are drifted
    // registrations belonging to whoever declared them — this action declares
    // neither, so neither may move its verdict.
    const verdict = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'always' }],
      streamId: 'feature-x',
      landed: ['workflow.started', 'stack.restacked', 'merge.rollback'],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('ok');
    expect(verdict.lifecycleViolations).toEqual([]);

    // And the scoping subtracts only: the same undeclared landings alongside a
    // missing declared emission still leave the miss reported.
    const stillMissing = verifyDeclaredEmissions({
      declared: [{ event: 'promotion.executed', condition: 'always' }],
      streamId: 'feature-x',
      landed: ['stack.restacked', 'merge.rollback'],
      annotations: ANNOTATIONS,
    });
    expect(stillMissing.status).toBe('violated');
    expect(stillMissing.missingEvents).toEqual(['promotion.executed']);
    expect(stillMissing.lifecycleViolations).toEqual([]);
  });

  it('EmissionVerifier_ConditionalEdge_IsNotCountedSatisfied', () => {
    // A conditional edge is out of subject. Landing it does not earn a pass,
    // and the verdict must not read `ok` — there was nothing to earn one with.
    const conditionalOnly = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'conditional' }],
      streamId: 'feature-x',
      landed: ['workflow.started'],
      annotations: ANNOTATIONS,
    });

    expect(conditionalOnly.status).toBe('not-applicable');
    expect(conditionalOnly.reason).toBe('no-unconditional-contract');
    expect(conditionalOnly.required).toEqual([]);

    // And the other direction: a conditional edge that landed cannot be spent
    // discharging a DIFFERENT unconditional promise that did not.
    const cannotSubstitute = verifyDeclaredEmissions({
      declared: [
        { event: 'workflow.started', condition: 'conditional' },
        { event: 'promotion.executed', condition: 'always' },
      ],
      streamId: 'feature-x',
      landed: ['workflow.started'],
      annotations: ANNOTATIONS,
    });

    expect(cannotSubstitute.status).toBe('violated');
    expect(cannotSubstitute.missingEvents).toEqual(['promotion.executed']);
    expect(cannotSubstitute.required).toEqual(['promotion.executed']);
  });

  it('reports an active landing and an unregistered landing as no fault', () => {
    // `active` agrees with runtime. An event absent from the table is an
    // unanswered question owned by a different diagnostic, not a fault here —
    // without this, every unannotated event would double-report under a name
    // that does not describe it.
    expect(lifecycleViolations(['workflow.started', 'never.registered'], ANNOTATIONS)).toEqual([]);

    const verdict = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'always' }],
      streamId: 'feature-x',
      landed: ['workflow.started', 'never.registered'],
      annotations: ANNOTATIONS,
    });
    expect(verdict.status).toBe('ok');
  });

  it('reports a repeated non-emitting landing once', () => {
    // The same event landing twice is one drifted registration, not two.
    expect(lifecycleViolations(['stack.restacked', 'stack.restacked'], ANNOTATIONS)).toEqual([
      { event: 'stack.restacked', lifecycle: 'planned' },
    ]);
  });

  it('reports a missing emission and a lifecycle violation together', () => {
    // Neither fault masks the other: short-circuiting on the first would make
    // the second invisible until the first was repaired. Both edges are this
    // action's, so both faults are its own.
    const verdict = verifyDeclaredEmissions({
      declared: [
        { event: 'promotion.executed', condition: 'always' },
        { event: 'stack.restacked', condition: 'always' },
      ],
      streamId: 'feature-x',
      landed: ['stack.restacked'],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('violated');
    expect(verdict.missingEvents).toEqual(['promotion.executed']);
    expect(verdict.lifecycleViolations).toEqual([
      { event: 'stack.restacked', lifecycle: 'planned' },
    ]);
  });
});

describe('EmissionVerifier run summary', () => {
  it('counts a store-failure run and a conditional-only run apart, not together', () => {
    // Same shape at the verdict level — both are "answered nothing" — but a
    // different REASON: a store failure is a subject that was never assessed,
    // a conditional-only edge is a subject that was never in scope. Folding
    // them into one `indeterminate` counter would make the two summaries
    // below print identically, which is exactly the confusion the split
    // exists to prevent.
    const storeFailureRun: readonly EmissionVerdict[] = [
      {
        status: 'indeterminate',
        cause: 'store-unavailable',
        missingEvents: [],
        lifecycleViolations: [],
        required: ['workflow.started'],
      },
    ];
    const conditionalOnlyRun: readonly EmissionVerdict[] = [
      {
        status: 'not-applicable',
        reason: 'no-unconditional-contract',
        missingEvents: [],
        lifecycleViolations: [],
        required: [],
      },
    ];

    const storeFailureSummary = summarizeEmissionRun(storeFailureRun);
    const conditionalOnlySummary = summarizeEmissionRun(conditionalOnlyRun);

    expect(storeFailureSummary.indeterminate).toBe(1);
    expect(storeFailureSummary.notApplicable).toBe(0);
    expect(conditionalOnlySummary.notApplicable).toBe(1);
    expect(conditionalOnlySummary.indeterminate).toBe(0);
    expect(storeFailureSummary).not.toEqual(conditionalOnlySummary);
  });
});

describe('EmissionVerifier declared-subject authority', () => {
  const sibling = [{ event: 'gate.executed', condition: 'always' as const }];
  const nested = {
    event: 'workflow.started',
    condition: 'always' as const,
    owner: 'workflow',
    role: 'primary' as const,
  };

  it('reads nested emissions and ignores a sibling fallback argument', () => {
    const read = verifierDeclaredEmissions as (
      contract: { readonly emissions: { readonly kind: 'declared' | 'none'; readonly values?: readonly typeof nested[]; readonly because?: string } } | undefined,
      siblingAutoEmits?: readonly typeof sibling,
    ) => readonly { readonly event: string }[] | undefined;

    expect(
      read({ emissions: { kind: 'declared', values: [nested] } }, sibling)?.map((row) => row.event),
    ).toEqual(['workflow.started']);
    expect(read({ emissions: { kind: 'none', because: 'reasoned silence' } }, sibling)).toBeUndefined();
    expect(read(undefined, sibling)).toBeUndefined();
  });
});
