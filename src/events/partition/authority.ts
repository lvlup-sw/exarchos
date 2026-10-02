/**
 * Derives the governance/telemetry partition over the event catalog.
 *
 * An event is GOVERNANCE when something depends on it: the canonical fold folds it, or a
 * correctness-bearing reader outside the fold reads it raw. Every other event is TELEMETRY.
 * The tier gives the start answer: `auto` is governance, and any other tier is telemetry.
 *
 * A WITNESS promotes a type and cites evidence that an oracle re-measures. A DEMOTION is a
 * charter act and never a measurement, because no instrument can prove that nothing reads a
 * type. The instruments re-check each demotion, so an instrument gap can only over-retain.
 *
 * Telemetry is safe to drop for the canonical fold only. A secondary view can still decide on it.
 */

import type { EmissionSource } from '../event-registration.js';

/** Whether anything depends on the event being present. */
export type EventAuthority = 'governance' | 'telemetry';

/**
 * How a promotion is proved. A `gate-expectation` read has no literal in source. The gate
 * asks if each type in a DECLARED expectation table is in the stream, so its oracle reads the table.
 */
export type AuthorityArm =
  | 'projection-fold'
  | 'raw-reader'
  | 'gate-expectation'
  | 'charter-pin';

/**
 * Why a type whose tier is not governance is governance anyway. The witness carries its
 * evidence: module paths that an oracle re-measures, or the citation of the ratified decision.
 */
export interface AuthorityWitness {
  readonly arm: AuthorityArm;
  /** Module paths (repo-relative, forward-slashed), or the charter's citation. */
  readonly evidence: readonly [string, ...string[]];
  readonly because: string;
}

/**
 * A comment on the roadmap issue, the only place where a charter act is made. The issue
 * number is part of the type, so a comment on another issue does not compile.
 */
export type CharterActUrl =
  `https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-${number}`;

/** A comment on the event-authority decision issue, where the record was ratified. */
export type DecisionRecordCitation =
  `https://github.com/lvlup-sw/exarchos/issues/1876#issuecomment-${number}`;

/**
 * Why a type whose tier is governance is telemetry anyway. The only basis is the charter act
 * that ordered the flip. Both citations are typed, so a placeholder does not compile. The
 * `because` states what the author read on the tree, so a reviewer can read the same places.
 */
export interface CharterDemotion {
  /** The charter act on the roadmap that ordered THIS flip. */
  readonly act: CharterActUrl;
  /** The ratified decision the act executes. */
  readonly record: DecisionRecordCitation;
  readonly because: string;
}

/**
 * Partitions a population of event types into governance and telemetry. A type is
 * `governance` when it has a witness, or when its tier derives `auto` and it has no demotion.
 * `tierSourceOf` must ignore lifecycle, because a `retired` type can still sit in a replayed stream.
 * Do not pass `resolveEmissionSource`, which applies lifecycle first.
 *
 * It throws on an empty population and on an unannotated type. It throws on a witness or a
 * demotion for a type outside the population, and on a type with both. It throws on dead
 * cover: a witness on an `auto` type, or a demotion on a type that is telemetry by tier.
 */
export function deriveEventAuthority(
  eventTypes: Iterable<string>,
  tierSourceOf: (eventType: string) => EmissionSource | undefined,
  witnesses: Readonly<Record<string, AuthorityWitness>>,
  demotions: Readonly<Record<string, CharterDemotion>> = {},
): Record<string, EventAuthority> {
  const derived: Record<string, EventAuthority> = {};
  const unannotated: string[] = [];
  const contradicted: string[] = [];
  const deadCoverWitnesses: string[] = [];
  const deadCoverDemotions: string[] = [];
  let population = 0;

  for (const eventType of eventTypes) {
    population += 1;
    const tierSource = tierSourceOf(eventType);
    if (tierSource === undefined) {
      unannotated.push(eventType);
      continue;
    }
    const witness = witnesses[eventType];
    const demotion = demotions[eventType];
    if (witness !== undefined && demotion !== undefined) {
      contradicted.push(eventType);
      continue;
    }
    if (tierSource === 'auto') {
      if (witness !== undefined) deadCoverWitnesses.push(eventType);
      derived[eventType] = demotion === undefined ? 'governance' : 'telemetry';
      continue;
    }
    if (demotion !== undefined) deadCoverDemotions.push(eventType);
    derived[eventType] = witness === undefined ? 'telemetry' : 'governance';
  }

  if (population === 0) {
    throw new Error(
      'deriveEventAuthority: refusing to partition an empty event-type population. An empty ' +
        'map reads to every consumer as "no event has an authority", so a moved or renamed ' +
        'catalog must fail here rather than pass clean.',
    );
  }
  if (unannotated.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${unannotated.length} event type(s) carry no registration, so no ` +
        `tier and therefore no authority can be derived for them: ${unannotated.sort().join(', ')}. ` +
        'Annotate the type rather than defaulting its authority.',
    );
  }

  const inPopulation = (eventType: string): boolean =>
    derived[eventType] !== undefined || contradicted.includes(eventType);
  const staleWitnesses = Object.keys(witnesses).filter((eventType) => !inPopulation(eventType));
  if (staleWitnesses.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${staleWitnesses.length} governance witness(es) name an event type ` +
        `that is not in the population: ${staleWitnesses.sort().join(', ')}. A witness for a ` +
        'renamed or deleted type promotes nothing and must be removed with the type.',
    );
  }
  const staleDemotions = Object.keys(demotions).filter((eventType) => !inPopulation(eventType));
  if (staleDemotions.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${staleDemotions.length} charter demotion(s) name an event type ` +
        `that is not in the population: ${staleDemotions.sort().join(', ')}. A demotion for a ` +
        'renamed or deleted type demotes nothing and must be removed with the type.',
    );
  }
  if (contradicted.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${contradicted.length} event type(s) carry BOTH a governance ` +
        `witness and a charter demotion: ${contradicted.sort().join(', ')}. The tables ` +
        'contradict each other — either the flip was overtaken by a new reader, in which case ' +
        'the demotion is false and must go, or the reader the witness cites was retired for the ' +
        'flip, in which case the witness must go. Neither is decided here.',
    );
  }
  if (deadCoverWitnesses.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${deadCoverWitnesses.length} governance witness(es) cover a type ` +
        `whose tier already derives governance: ${deadCoverWitnesses.sort().join(', ')}. The ` +
        'declaration changes no answer, so nothing can check it — delete it, or re-tier the ' +
        'event if the tier is wrong.',
    );
  }
  if (deadCoverDemotions.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${deadCoverDemotions.length} charter demotion(s) cover a type ` +
        `whose tier already derives telemetry: ${deadCoverDemotions.sort().join(', ')}. The ` +
        'row changes no answer, so nothing can check it — delete it; a type that is telemetry ' +
        'by tier needs no charter act to stay so.',
    );
  }

  return derived;
}

/** Splits a derived map into its two sides. */
export function partitionByAuthority(
  authority: Readonly<Record<string, EventAuthority>>,
): { readonly governance: ReadonlySet<string>; readonly telemetry: ReadonlySet<string> } {
  const governance = new Set<string>();
  const telemetry = new Set<string>();
  for (const [eventType, value] of Object.entries(authority)) {
    if (value === 'governance') governance.add(eventType);
    else telemetry.add(eventType);
  }
  return Object.freeze({ governance, telemetry });
}
