// ─── DR-2 / task 011: EventEmissionSource is DERIVED, never independently authored ──────────
//
// @oracle-sources: ./event-annotations.ts, the DR-2 derivation criterion ("source is derived from
// tier and lifecycle, never independently authored; a seeded tier<->source disagreement fails")
//
// ONE module authority, not three, and that is the point of the task. Before task 011,
// `schemas.ts`'s source column and `event-annotations.ts`'s tier assignment were two independent
// authorities that could disagree — and did, on `benchmark.completed`. They are now one:
// `EVENT_EMISSION_REGISTRY` is a projection of the annotations. Listing `./schemas.ts` or
// `./event-registration.ts` as additional authorities would be listing the same authority under
// three names. The second oracle is therefore the DR-2 criterion itself, applied to SEEDED inputs
// this file constructs.
//
// The claim under test is not "a disagreement is detected". It is that a built-in event type has
// no site at which a source can be written, so a source that disagrees with the tier has no form
// to take. `EVENT_EMISSION_REGISTRY` used to be 170 hand-written string literals; it is now
// `deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf)`.
//
// WHY THE KILL PROBE IS SHAPED THE WAY IT IS. "Seed a registration whose independently-authored
// source contradicts its tier and prove it fails" is only meaningful against a mechanism that
// CONSUMES an authored source. The derivation does not consume one — so the probe seeds the
// contradiction on both sides at once and asserts the two halves of the property:
//
//   1. the derivation IGNORES the authored value entirely (it follows the tier), and
//   2. the census that still takes a declared map as a parameter REPORTS the contradiction by
//      name, so the claim retains a way to be wrong.
//
// Assert (1) without (2) and a derivation that always returned `'auto'` would pass. Assert (2)
// without (1) and this is task 010's test again, measuring detection rather than derivation.
//
// The compile-time half is not here: `tsconfig.json` excludes `**/*.test.ts`, so the type-level
// proofs live as exported `_EventRegistration_*` aliases in `event-registration.ts`, where
// `npm run typecheck` verifies them.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  deriveEmissionRegistry,
  findTierSourceDisagreement,
  resolveEmissionSource,
  type EventRegistration,
} from './event-registration.js';
import { ANNOTATED_EVENTS, tierSourceDisagreements } from './event-annotations.js';
import { EVENT_EMISSION_REGISTRY, EventTypes, type EventEmissionSource } from './schemas.js';

/**
 * A seeded population: one `judgment` registration (which derives `'model'`) whose source someone
 * has independently authored as `'auto'`. This is the contradiction DR-2 says must fail.
 */
const SEEDED_TIER: EventRegistration = {
  lifecycle: 'active',
  tier: 'judgment',
  gate: 'review-verdict',
  // A judgment weld needs a content schema; its identity is irrelevant to the emission axis, so
  // the cheapest real inhabitant of the field is used.
  contentSchema: z.object({ verdict: z.string() }),
};

/** The same event, `retired` — the case the rev-3 correction says is NOT a disagreement. */
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
  it('EmissionDerivation_SeededSourceContradictingItsTier_HasNoEffectAndIsReported', () => {
    // ── Half 1: the derivation ignores the authored value ────────────────────────────────────
    //
    // 'seeded.verdict' is annotated `judgment`, which derives 'model'. Whoever wrote 'auto' below
    // wrote it into a map the derivation never reads.
    const authored: Readonly<Record<string, EventEmissionSource>> = { 'seeded.verdict': 'auto' };
    const derived = deriveEmissionRegistry(
      ['seeded.verdict'],
      seededLookup({ 'seeded.verdict': SEEDED_TIER }),
    );

    expect(derived['seeded.verdict']).toBe('model');
    expect(derived['seeded.verdict']).not.toBe(authored['seeded.verdict']);

    // ── Half 2: the contradiction is reported by name, so the claim can be wrong ──────────────
    const disagreement = findTierSourceDisagreement(SEEDED_TIER, 'auto');
    expect(disagreement?.code).toBe('TIER_SOURCE_DISAGREEMENT');
    expect(disagreement?.declared).toBe('auto');
    expect(disagreement?.derived).toBe('model');
    expect(disagreement?.tier).toBe('judgment');

    // ── The lifecycle exemption is a property of the axis, not a blanket pass ────────────────
    //
    // A `retired` registration declaring 'retired' AGREES even though its capability tier would
    // derive 'auto' were it active; declaring it 'auto' does NOT agree.
    expect(resolveEmissionSource(SEEDED_RETIRED)).toBe('retired');
    expect(findTierSourceDisagreement(SEEDED_RETIRED, 'retired')).toBeUndefined();
    expect(findTierSourceDisagreement(SEEDED_RETIRED, 'auto')?.derived).toBe('retired');
  });

  it('EmissionDerivation_LiveRegistry_IsTheDerivationOfEveryAnnotation', () => {
    // The registry is rebuilt here from the same inputs `schemas.ts` uses and compared entry by
    // entry. This is what goes red if the derivation is reverted to hand-written literals: the
    // old table declared `benchmark.completed` as 'hook' while its tier derives 'auto'.
    const rebuilt = deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf);

    // NON-EMPTY DENOMINATOR, asserted before the comparison: an empty catalog would make every
    // "no mismatch" claim below vacuously true.
    expect(EventTypes.length).toBeGreaterThan(0);
    expect(Object.keys(rebuilt).length).toBe(EventTypes.length);
    expect(Object.keys(EVENT_EMISSION_REGISTRY).length).toBe(EventTypes.length);

    const mismatched = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] !== rebuilt[eventType],
    );
    expect(mismatched).toEqual([]);

    // And nothing in the live catalog contradicts its own tier — the task-010 exception is gone.
    expect(tierSourceDisagreements(EVENT_EMISSION_REGISTRY)).toEqual([]);

    // The one value the derivation MOVED, named explicitly so the change is a fact this suite
    // states rather than a silent consequence. `benchmark.completed` is annotated `capability`
    // (two real consumer folds, appended through the `exarchos_event` seam) and has no emitter
    // anywhere in the tree; the retired hand-written column called it 'hook'.
    expect(EVENT_EMISSION_REGISTRY['benchmark.completed']).toBe('auto');
  });

  it('EmissionDerivation_EmptyPopulation_FailsInsteadOfProducingACleanEmptyRegistry', () => {
    // A moved, renamed or mis-imported catalog resolves zero event types. Returning `{}` would
    // read to every consumer as "no event has a source" — the exact shape of a census that passes
    // because it measured nothing.
    expect(() => deriveEmissionRegistry([], seededLookup({}))).toThrow(/empty event-type population/);
  });

  it('EmissionDerivation_RegisteredTypeWithNoTier_FailsClosedAndNamesIt', () => {
    // No tier means no derivable source. Defaulting it is the guess that let the hand-written
    // column drift in the first place, so this fails at load and names every offender.
    expect(() =>
      deriveEmissionRegistry(
        ['seeded.verdict', 'seeded.orphan'],
        seededLookup({ 'seeded.verdict': SEEDED_TIER }),
      ),
    ).toThrow(/seeded\.orphan/);

    // The failure is about the MISSING annotation, not about the population being small: the same
    // call with the orphan annotated succeeds.
    const ok = deriveEmissionRegistry(
      ['seeded.verdict', 'seeded.orphan'],
      seededLookup({ 'seeded.verdict': SEEDED_TIER, 'seeded.orphan': SEEDED_RETIRED }),
    );
    expect(ok).toEqual({ 'seeded.verdict': 'model', 'seeded.orphan': 'retired' });
  });
});
