// @oracle-sources: ../../../src/events/event-annotations.ts, the derivation criterion ("source is derived from
// tier and lifecycle, never independently authored; a seeded tier<->source disagreement fails")
//
// `EventEmissionSource` is derived, never authored. `EVENT_EMISSION_REGISTRY` is a projection of the
// annotations, so the annotations are the one module authority. The second oracle is the derivation
// criterion, applied to seeded inputs that this file builds.
//
// A built-in event type has no site where a source can be written. So the kill probe seeds the
// contradiction on both sides and asserts two halves. First, the derivation follows the tier and
// reads no authored value. Second, `findTierSourceDisagreement` reports the contradiction for a
// declared source. Without the second half, the claim has no way to be wrong.
//
// The type-level proofs are the exported `_EventRegistration_*` aliases in `event-registration.ts`.
// `tsconfig.json` excludes test files, so `npm run typecheck` verifies the aliases there.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  deriveEmissionRegistry,
  findTierSourceDisagreement,
  resolveEmissionSource,
  type EventRegistration,
} from '../../../src/events/event-registration.js';
import { ANNOTATED_EVENTS, tierSourceDisagreements } from '../../../src/events/event-annotations.js';
import { EVENT_EMISSION_REGISTRY, EventTypes, type EventEmissionSource } from '../../../src/events/schemas.js';

/**
 * A seeded `judgment` registration. The tier derives `'model'`, and the kill probe authors `'auto'`
 * against it. The derivation criterion requires that contradiction to fail.
 */
const SEEDED_TIER: EventRegistration = {
  lifecycle: 'active',
  tier: 'judgment',
  gate: 'review-verdict',
  /** A judgment weld needs a content schema. Its identity does not affect the emission axis. */
  contentSchema: z.object({ verdict: z.string() }),
};

/** A `retired` capability registration. A declared `'retired'` agrees with it, and a declared `'auto'` does not. */
const SEEDED_RETIRED: EventRegistration = {
  lifecycle: 'retired',
  tier: 'capability',
  provider: 'exarchos_event',
  consumedBy: ['code-quality'],
};

const seededLookup =
  (table: Readonly<Record<string, EventRegistration>>) =>
  (eventType: string): EventRegistration | undefined =>
    table[eventType];

describe('EmissionDerivation — source follows the tier, and cannot be authored against it', () => {
  /**
   * Half 1: `seeded.verdict` has the `judgment` tier, which derives `'model'`. The authored `'auto'`
   * sits in a map that the derivation never reads. Half 2: `findTierSourceDisagreement` reports the
   * contradiction with its code, both sources, and the tier. The lifecycle exemption is not a blanket pass.
   * A `retired` registration agrees with `'retired'` and not with `'auto'`, which its capability tier
   * derives when active.
   */
  it('EmissionDerivation_SeededSourceContradictingItsTier_HasNoEffectAndIsReported', () => {
    const authored: Readonly<Record<string, EventEmissionSource>> = { 'seeded.verdict': 'auto' };
    const derived = deriveEmissionRegistry(
      ['seeded.verdict'],
      seededLookup({ 'seeded.verdict': SEEDED_TIER }),
    );

    expect(derived['seeded.verdict']).toBe('model');
    expect(derived['seeded.verdict']).not.toBe(authored['seeded.verdict']);

    const disagreement = findTierSourceDisagreement(SEEDED_TIER, 'auto');
    expect(disagreement?.code).toBe('TIER_SOURCE_DISAGREEMENT');
    expect(disagreement?.declared).toBe('auto');
    expect(disagreement?.derived).toBe('model');
    expect(disagreement?.tier).toBe('judgment');

    expect(resolveEmissionSource(SEEDED_RETIRED)).toBe('retired');
    expect(findTierSourceDisagreement(SEEDED_RETIRED, 'retired')).toBeUndefined();
    expect(findTierSourceDisagreement(SEEDED_RETIRED, 'auto')?.derived).toBe('retired');
  });

  /**
   * The case builds the registry again from the inputs that `schemas.ts` uses and compares each entry.
   * A hand-written registry that drifts from the annotations fails here. The counts come first,
   * because an empty catalog makes the comparison vacuous. The live catalog has no standing exception.
   *
   * `benchmark.completed` is `capability` and `planned`, so its lifecycle gives the source.
   * With an `active` lifecycle, the tier gives `'auto'`, a claim that an effect provider appends the event.
   * No module appends that event, so the claim is false.
   */
  it('EmissionDerivation_LiveRegistry_IsTheDerivationOfEveryAnnotation', () => {
    const rebuilt = deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf);

    expect(EventTypes.length).toBeGreaterThan(0);
    expect(Object.keys(rebuilt).length).toBe(EventTypes.length);
    expect(Object.keys(EVENT_EMISSION_REGISTRY).length).toBe(EventTypes.length);

    const mismatched = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] !== rebuilt[eventType],
    );
    expect(mismatched).toEqual([]);

    expect(tierSourceDisagreements(EVENT_EMISSION_REGISTRY)).toEqual([]);

    expect(EVENT_EMISSION_REGISTRY['benchmark.completed']).toBe('planned');
  });

  /** A moved or renamed catalog resolves zero event types. An empty registry reads as "no event has a source". */
  it('EmissionDerivation_EmptyPopulation_FailsInsteadOfProducingACleanEmptyRegistry', () => {
    expect(() => deriveEmissionRegistry([], seededLookup({}))).toThrow(/empty event-type population/);
  });

  /**
   * A type with no registration has no derivable source, and the derivation gives it no default.
   * The error names the type. The same call succeeds when the type has a registration.
   * So the failure is about the missing registration, not about the size of the population.
   */
  it('EmissionDerivation_RegisteredTypeWithNoTier_FailsClosedAndNamesIt', () => {
    expect(() =>
      deriveEmissionRegistry(
        ['seeded.verdict', 'seeded.orphan'],
        seededLookup({ 'seeded.verdict': SEEDED_TIER }),
      ),
    ).toThrow(/seeded\.orphan/);

    const ok = deriveEmissionRegistry(
      ['seeded.verdict', 'seeded.orphan'],
      seededLookup({ 'seeded.verdict': SEEDED_TIER, 'seeded.orphan': SEEDED_RETIRED }),
    );
    expect(ok).toEqual({ 'seeded.verdict': 'model', 'seeded.orphan': 'retired' });
  });
});
