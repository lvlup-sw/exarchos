// Runtime tests for the `EventRegistration` union.
//
// `tsconfig.json` excludes test files, so `tsc` does not see a type-level assertion here.
// `_EventRegistration_ReportCoupledVariant_HasNoConstructibleForm` and the other type proofs are
// exported aliases at the end of `event-registration.ts`, where `npm run typecheck` checks them.
//
// This file covers the runtime half. A real function carries the exhaustiveness of the union,
// and the two axes stay separate when the code resolves them.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  EVENT_TIERS,
  EMISSION_SOURCE_BY_TIER,
  findTierSourceDisagreement,
  resolveEmissionSource,
  weldReferenceOf,
  type EventRegistration,
  type EventTier,
} from '../../../src/events/event-registration.js';

/** One live registration for each tier, keyed by `EventTier`. */
const FIXTURE_BY_TIER: Readonly<Record<EventTier, EventRegistration>> = {
  substrate: {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  capability: {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['task-store@v1'],
  },
  observation: {
    lifecycle: 'active',
    tier: 'observation',
    reconciler: 'worktree',
    groundTruth: 'process',
  },
  judgment: {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'test-adequacy',
    contentSchema: z.object({ verdict: z.string() }),
  },
  'workflow-local': {
    lifecycle: 'active',
    tier: 'workflow-local',
    workflow: 'sdlc',
  },
  harness: {
    lifecycle: 'active',
    tier: 'harness',
    module: 'tools/evals/evals/harness.ts',
    consumedBy: ['eval-results'],
  },
};

/** The weld reference that each fixture must give. A person writes it, so it is a second authority. */
const EXPECTED_WELD_REF: Readonly<Record<EventTier, string>> = {
  substrate: 'transition-record',
  capability: 'exarchos_orchestrate',
  observation: 'worktree',
  judgment: 'test-adequacy',
  'workflow-local': 'sdlc',
  harness: 'tools/evals/evals/harness.ts',
};

describe('EventRegistration', () => {
  /**
   * The `default` arm of `weldReferenceOf` returns the registration, whose `ref` is undefined.
   * Thus the `ref` assertion fails at runtime for a tier with no case.
   * The expected tier list is a literal and not `EVENT_TIERS`, so the test compares two authorities.
   */
  it('EventRegistration_EveryTier_IsExhaustivelyHandled', () => {
    const handled: string[] = [];

    for (const tier of EVENT_TIERS) {
      const weld = weldReferenceOf(FIXTURE_BY_TIER[tier]);
      expect(weld.tier).toBe(tier);
      expect(weld.ref).toBe(EXPECTED_WELD_REF[tier]);
      handled.push(weld.tier);
    }

    expect(handled).toEqual([
      'substrate',
      'capability',
      'observation',
      'judgment',
      'workflow-local',
      'harness',
    ]);
  });

  /**
   * A retired event keeps the tier of its live weld. The lifecycle gives its source, so `retired`
   * is not a disagreement although the tier derives `auto`. `planned` works the same way: the
   * `judgment` tier derives `model` when active.
   */
  it('EventRegistration_RetiredLifecycle_IsNotATierSourceDisagreement', () => {
    const retired: EventRegistration = {
      lifecycle: 'retired',
      tier: 'capability',
      provider: 'exarchos_event',
      consumedBy: ['rehydration@v1'],
    };

    expect(EMISSION_SOURCE_BY_TIER.capability).toBe('auto');
    expect(resolveEmissionSource(retired)).toBe('retired');
    expect(findTierSourceDisagreement(retired, 'retired')).toBeUndefined();

    const planned: EventRegistration = {
      lifecycle: 'planned',
      tier: 'judgment',
      gate: 'review-verdict',
      contentSchema: z.object({ verdict: z.string() }),
    };
    expect(EMISSION_SOURCE_BY_TIER.judgment).toBe('model');
    expect(resolveEmissionSource(planned)).toBe('planned');
    expect(findTierSourceDisagreement(planned, 'planned')).toBeUndefined();
  });

  /**
   * Each active tier gives exactly one of `auto`, `model` and `hook`, and never a lifecycle value.
   * The expected list is in `EVENT_TIERS` order.
   * `workflow-local` is `model`: a step of a workflow definition composes the emission.
   * `harness` is `auto`: the harness code computes the payload, and `model` requires a
   * `.describe()` on each schema field for a model.
   */
  it('ResolveEmissionSource_ActiveRegistration_DerivesFromTierAloneAcrossAllTiers', () => {
    const derived: string[] = [];
    for (const tier of EVENT_TIERS) {
      const source = resolveEmissionSource(FIXTURE_BY_TIER[tier]);
      expect(source).not.toBe('planned');
      expect(source).not.toBe('retired');
      derived.push(source);
    }
    expect(derived).toEqual(['auto', 'auto', 'hook', 'model', 'model', 'auto']);
  });

  /**
   * The seeded disagreement: a substrate event that the registry declares as `model`.
   * The agreeing case gives no finding, so the check is not vacuously positive.
   */
  it('FindTierSourceDisagreement_SeededTierSourceMismatch_IsReported', () => {
    const seeded = findTierSourceDisagreement(FIXTURE_BY_TIER.substrate, 'model');

    expect(seeded?.code).toBe('TIER_SOURCE_DISAGREEMENT');
    expect(seeded?.tier).toBe('substrate');
    expect(seeded?.lifecycle).toBe('active');
    expect(seeded?.declared).toBe('model');
    expect(seeded?.derived).toBe('auto');

    expect(findTierSourceDisagreement(FIXTURE_BY_TIER.substrate, 'auto')).toBeUndefined();
  });

  /**
   * The lifecycle rule is not a blanket exemption. A retired entry that the registry declares as
   * `auto` is a disagreement, because the lifecycle says that nothing emits the event.
   */
  it('FindTierSourceDisagreement_RetiredEntryDeclaredWithItsTierSource_IsReported', () => {
    const retired: EventRegistration = {
      lifecycle: 'retired',
      tier: 'substrate',
      rationale: 'session-lifecycle',
    };

    const disagreement = findTierSourceDisagreement(retired, 'auto');
    expect(disagreement?.derived).toBe('retired');
    expect(disagreement?.declared).toBe('auto');
  });
});
