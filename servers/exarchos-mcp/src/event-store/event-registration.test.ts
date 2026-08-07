// ─── DR-2: the five-tier EventRegistration union ────────────────────────────
//
// WHERE THE THIRD TEST LIVES. `EventRegistration_ReportCoupledVariant_HasNoConstructibleForm`
// is NOT in this file, and that is deliberate: `tsconfig.json` excludes `**/*.test.ts`, so a
// type-level assertion (or a `@ts-expect-error`) written here is never seen by `tsc` and would
// be decorative. It lives as an exported type alias at the bottom of `event-registration.ts`,
// where `npm run typecheck` — the static-analysis gate — verifies it, alongside
// `_EventRegistration_CapabilityWithNoConsumers_HasNoConstructibleForm`,
// `_EventRegistration_EveryTierArm_CarriesAWeldField` and the axis proofs.
//
// What this file covers is the RUNTIME half: that the union's exhaustiveness is carried by a
// real function, and that the two axes stay separated when they are actually resolved.

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
} from './event-registration.js';

/**
 * One live registration per tier. Typed as `Record<EventTier, EventRegistration>` so a tier
 * added to the union without a fixture is a compile error at the next `tsc` run rather than a
 * silently unexercised arm — the enumeration below can never range over less than the union.
 */
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
};

/** The weld reference each fixture should yield — hand-written, so it is a second authority. */
const EXPECTED_WELD_REF: Readonly<Record<EventTier, string>> = {
  substrate: 'transition-record',
  capability: 'exarchos_orchestrate',
  observation: 'worktree',
  judgment: 'test-adequacy',
  'workflow-local': 'sdlc',
};

describe('EventRegistration', () => {
  it('EventRegistration_EveryTier_IsExhaustivelyHandled', () => {
    const handled: string[] = [];

    for (const tier of EVENT_TIERS) {
      const weld = weldReferenceOf(FIXTURE_BY_TIER[tier]);
      // The switch in `weldReferenceOf` has no `default` arm that invents a value: an unhandled
      // tier falls through to the `never` binding and returns the registration itself, whose
      // `ref` is undefined. So this assertion is what turns a dropped case red at runtime, and
      // `tsc` turns it red at build time.
      expect(weld.tier).toBe(tier);
      expect(weld.ref).toBe(EXPECTED_WELD_REF[tier]);
      handled.push(weld.tier);
    }

    // Pinned against a hand-written list rather than against `EVENT_TIERS` itself, so this is a
    // comparison of two authorities and not one value read twice.
    expect(handled).toEqual([
      'substrate',
      'capability',
      'observation',
      'judgment',
      'workflow-local',
    ]);
  });

  it('EventRegistration_RetiredLifecycle_IsNotATierSourceDisagreement', () => {
    // A retired event still declares the tier it was welded to when it was live. Its tier would
    // derive 'auto' were it active — but it is not, and `retired` is what the registry holds.
    const retired: EventRegistration = {
      lifecycle: 'retired',
      tier: 'capability',
      provider: 'exarchos_event',
      consumedBy: ['rehydration@v1'],
    };

    expect(EMISSION_SOURCE_BY_TIER.capability).toBe('auto');
    expect(resolveEmissionSource(retired)).toBe('retired');
    expect(findTierSourceDisagreement(retired, 'retired')).toBeUndefined();

    // Same for the mirror lifecycle state: `planned` comes from the lifecycle axis, never from
    // the tier, even though this tier derives 'model' when active.
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

  it('ResolveEmissionSource_ActiveRegistration_DerivesFromTierAloneAcrossAllTiers', () => {
    // Derivation is total over the emission axis: every ACTIVE tier produces exactly one of
    // 'auto' | 'model' | 'hook', and never a lifecycle value.
    const derived: string[] = [];
    for (const tier of EVENT_TIERS) {
      const source = resolveEmissionSource(FIXTURE_BY_TIER[tier]);
      expect(source).not.toBe('planned');
      expect(source).not.toBe('retired');
      derived.push(source);
    }
    expect(derived).toEqual(['auto', 'auto', 'hook', 'model', 'auto']);
  });

  it('FindTierSourceDisagreement_SeededTierSourceMismatch_IsReported', () => {
    // The seeded disagreement DR-2 requires to fail: a substrate event — welded to the store's
    // own machinery — that the registry nonetheless declares as model-authored.
    const seeded = findTierSourceDisagreement(FIXTURE_BY_TIER.substrate, 'model');

    expect(seeded?.code).toBe('TIER_SOURCE_DISAGREEMENT');
    expect(seeded?.tier).toBe('substrate');
    expect(seeded?.lifecycle).toBe('active');
    expect(seeded?.declared).toBe('model');
    expect(seeded?.derived).toBe('auto');

    // …and the agreeing case is silent, so the check is not vacuously positive.
    expect(findTierSourceDisagreement(FIXTURE_BY_TIER.substrate, 'auto')).toBeUndefined();
  });

  it('FindTierSourceDisagreement_RetiredEntryDeclaredWithItsTierSource_IsReported', () => {
    // The other half of the lifecycle rule, and the one that keeps it from being a blanket
    // exemption: a retired entry the registry still declares as 'auto' IS a disagreement —
    // something is emitting an event whose lifecycle says nothing does.
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
