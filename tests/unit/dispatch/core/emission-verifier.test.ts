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
 * A hand-built registration table. A test over the live catalog changes its meaning with each new
 * registration, and it cannot state a `planned` case until one exists.
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
  /**
   * Both required events landed, so no event is missing. The fault is that the action declares
   * and emits two events whose registrations say that nothing emits them. A conditional edge is
   * not required, but it is still drift when it lands against such a registration.
   */
  it('LifecycleVerifier_DeclaredRetiredEvent_FailsAction', () => {
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
    expect(verdict.lifecycleViolations).toEqual([
      { event: 'merge.rollback', lifecycle: 'retired' },
      { event: 'stack.restacked', lifecycle: 'planned' },
    ]);
  });

  /**
   * An operation id is a shared join key. This action declares neither drifted landing, so neither
   * changes its verdict. The scoping only subtracts: a missing declared emission is still reported.
   */
  it('LifecycleVerifier_UnrelatedOperationEvent_DoesNotFailAction', () => {
    const verdict = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'always' }],
      streamId: 'feature-x',
      landed: ['workflow.started', 'stack.restacked', 'merge.rollback'],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('ok');
    expect(verdict.lifecycleViolations).toEqual([]);

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

  /**
   * A conditional edge is not part of the subject. When only that edge lands, the verdict is
   * `not-applicable` and not `ok`. A landed conditional edge also cannot satisfy a different
   * unconditional promise that did not land.
   */
  it('EmissionVerifier_ConditionalEdge_IsNotCountedSatisfied', () => {
    const conditionalOnly = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'conditional' }],
      streamId: 'feature-x',
      landed: ['workflow.started'],
      annotations: ANNOTATIONS,
    });

    expect(conditionalOnly.status).toBe('not-applicable');
    expect(conditionalOnly.reason).toBe('no-unconditional-contract');
    expect(conditionalOnly.required).toEqual([]);

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

  /**
   * `active` agrees with runtime. A different diagnostic owns an event that is absent from the
   * table, so it is not a fault here.
   */
  it('reports an active landing and an unregistered landing as no fault', () => {
    expect(lifecycleViolations(['workflow.started', 'never.registered'], ANNOTATIONS)).toEqual([]);

    const verdict = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'always' }],
      streamId: 'feature-x',
      landed: ['workflow.started', 'never.registered'],
      annotations: ANNOTATIONS,
    });
    expect(verdict.status).toBe('ok');
  });

  /** One event that lands twice is one drifted registration. */
  it('reports a repeated non-emitting landing once', () => {
    expect(lifecycleViolations(['stack.restacked', 'stack.restacked'], ANNOTATIONS)).toEqual([
      { event: 'stack.restacked', lifecycle: 'planned' },
    ]);
  });

  /** Neither fault hides the other. This action declares both edges, so both faults are its own. */
  it('reports a missing emission and a lifecycle violation together', () => {
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
  /**
   * Neither verdict answers, but the reasons differ. A store failure is a subject that the
   * verifier did not assess. A conditional-only edge is a subject that was not in scope. With one
   * shared counter, the two summaries are equal.
   */
  it('counts a store-failure run and a conditional-only run apart, not together', () => {
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
