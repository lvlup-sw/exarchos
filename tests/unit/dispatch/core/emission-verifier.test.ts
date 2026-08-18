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
  verifyDeclaredEmissions,
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
  it('EmissionVerifier_PlannedOrRetiredEmittedAtRuntime_Fails', () => {
    // The declared contract is kept in full — `workflow.started` landed. The
    // only fault is the company it arrived in.
    const verdict = verifyDeclaredEmissions({
      declared: [{ event: 'workflow.started', condition: 'always' }],
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
    // the second invisible until the first was repaired.
    const verdict = verifyDeclaredEmissions({
      declared: [{ event: 'promotion.executed', condition: 'always' }],
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
