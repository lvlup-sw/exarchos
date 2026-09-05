/**
 * The governance/telemetry partition over the event catalog, DERIVED.
 *
 * ── The question this answers ───────────────────────────────────────────────
 *
 * An event is a GOVERNANCE event when something depends on it being there: the
 * canonical projection folds it, or a correctness-bearing reader outside the
 * fold re-reads it raw (a fence, an idempotency check, an HSM guard). Every
 * other event is TELEMETRY — it records that something happened and nothing
 * decides anything from it.
 *
 * Before this module the catalog answered a different question. `EventTier`
 * says what an emission is welded to and `EventEmissionSource` says who
 * appends it; neither says whether anything reads it back. So "may this event
 * be dropped, re-ordered, or re-sourced" had no derivable answer, and the
 * absence read as permission.
 *
 * ── Tier, not lifecycle ─────────────────────────────────────────────────────
 *
 * The classifier consults `EMISSION_SOURCE_BY_TIER[registration.tier]`, NOT
 * `resolveEmissionSource`. That function composes lifecycle first, which would
 * mask ownership in both directions: a `retired` type can still sit in a
 * historical stream the fold replays, and a `planned` type has an ownership
 * answer before its first append is ever written. Authority is a property of
 * what the event is welded to, and lifecycle does not change that.
 *
 * ── Promotion by witness; demotion by charter act only ──────────────────────
 *
 * The tier gives a starting answer — `auto` is governance, anything else is
 * telemetry — and two hand-written tables override it in opposite directions.
 * Neither direction is open to an instrument on its own.
 *
 * A WITNESS promotes a non-`auto` type. A single observed fold arm or raw
 * reader is sufficient evidence for that, so a witness carries the module it
 * cites and an oracle re-measures it against the tree.
 *
 * A DEMOTION files an `auto` type as telemetry. That asserts "nothing depends
 * on this event" — a universal claim no instrument here can prove: the fold
 * measurement covers one projection, and the reader census has an acknowledged
 * blind spot (a table entry such as a liveness descriptor, or a bare fold whose
 * type comparison happens in another module). So a demotion is never derived
 * from a measurement. It is a JUDGMENT made by reading the tree, ordered by the
 * ratified charter and recorded as a charter act on the roadmap, and every row
 * carries that citation. What the instruments CAN do is re-measure the judgment
 * in the direction they are good at: once a type is telemetry, a fold arm that
 * mutates, a raw reader the census sees, a contract that promises it, an
 * expectation or description row that names it, or a liveness descriptor that
 * pairs on it is a named failure. A gap in an instrument therefore still only
 * over-retains; it never demotes anything by itself.
 *
 * The judgment has to be made against the tree, not the charter text. The
 * decision record listed `launch.executing_started` beside the hook-tier
 * self-reports; on the tree it is the START claim of the launch liveness pair,
 * which `ps` and the phantom-launch heal pair against through the operations
 * fold — a dependency the reader census cannot see. It stays governance.
 *
 * ── The map still disagrees with the charter's telemetry examples ───────────
 *
 * The ratified decision lists example telemetry types — the tool and turn
 * families, the team family, `shepherd.iteration`, `stack.submitted`,
 * `subagent.tokens_used`, `launch.executing_started`. The per-tool and turn
 * records and the token self-report are demoted; `stack.submitted` left the
 * emission gate's expectation table and is telemetry by tier. The rest still
 * classify GOVERNANCE here, each for a measured reason:
 *
 *   • the team family, `shepherd.iteration` and `launch.executing_started`
 *     carry a live fold arm, raw reader or liveness pairing today, so demoting
 *     them would be a false statement — the charter sequences each flip as its
 *     own change that retires the reader first.
 *
 * That disagreement is a BACKLOG, not a footnote, so it is counted rather than
 * described: the partition's own test pins the exact set of charter-named
 * telemetry examples still classified governance, a list that may only shrink.
 *
 * ── One more bound worth stating ────────────────────────────────────────────
 *
 * "The projection folds it" means the CANONICAL workflow-state fold. A secondary
 * view can still derive a decision from a telemetry-classified event — the
 * synthesis-readiness view computes its blockers from test and typecheck
 * results — so a consumer that drops telemetry is safe for the canonical state
 * and not yet proved safe for every view.
 *
 * ── Fail-closed, and by name ────────────────────────────────────────────────
 *
 * Built like `deriveEmissionRegistry`: a pure function over an injected
 * population and injected tables, so a probe can derive over a seeded catalog
 * without touching the live tables, and every refusal NAMES its offenders
 * rather than reporting a count.
 */

import type { EmissionSource } from '../event-registration.js';

/** Whether anything depends on the event being present. */
export type EventAuthority = 'governance' | 'telemetry';

/**
 * How a promotion is proved.
 *
 * `gate-expectation` is separate from `raw-reader` because the read it names is
 * indirect: the gate iterates a DECLARED expectation table and asks a set built
 * from the stream whether each listed type is present. No comparison against a
 * literal appears anywhere, so a source scan cannot see it; the table is the
 * evidence, and the oracle that re-measures this arm reads the table rather than
 * the tree.
 */
export type AuthorityArm =
  | 'projection-fold'
  | 'raw-reader'
  | 'gate-expectation'
  | 'charter-pin';

/**
 * Why a type whose tier does not make it governance is governance anyway.
 *
 * The witness is the whole basis for the promotion, so it carries its evidence
 * rather than asserting the conclusion: `projection-fold` and `raw-reader`
 * evidence are module paths an oracle re-measures against the tree, and
 * `charter-pin` evidence is the ratified decision's citation.
 */
export interface AuthorityWitness {
  readonly arm: AuthorityArm;
  /** Module paths (repo-relative, forward-slashed), or the charter's citation. */
  readonly evidence: readonly [string, ...string[]];
  readonly because: string;
}

/**
 * Why a type whose tier makes it governance is telemetry anyway.
 *
 * There is no arm to choose: a demotion has exactly one basis, the charter act
 * that ordered the flip, executing the ratified decision. The evidence names
 * both. The `because` states what was read on the tree to make the judgment —
 * which views fold the type, and that nothing outside them does — so a reviewer
 * can re-read the same places rather than trust the row.
 */
export interface CharterDemotion {
  /** The charter act on the roadmap, then the decision record it executes. */
  readonly evidence: readonly [string, ...string[]];
  readonly because: string;
}

/**
 * Partition a population of event types into governance and telemetry.
 *
 * The rule is one line and total: a type is `governance` iff it carries a
 * witness, OR its tier derives `auto` and it carries no demotion; otherwise it
 * is `telemetry`.
 *
 * Seven refusals, each because the alternative is a map that reads clean while
 * saying nothing:
 *
 *   • **Empty population.** An empty map reads to every consumer as "no event
 *     has an authority", which is exactly what a moved or renamed catalog
 *     produces.
 *   • **Unannotated type.** No tier, no derivable authority. Defaulting it
 *     would be the guess this derivation exists to remove.
 *   • **Witness or demotion for a type outside the population.** A renamed or
 *     deleted event leaves its row behind, still asserting an override for
 *     nothing.
 *   • **Witness AND demotion on one type.** The two tables contradict each
 *     other, and picking either silently would hide a flip that a new reader
 *     has since overtaken — or a reader that a flip has since orphaned.
 *   • **Witness on a type the tier already makes governance.** Dead cover: the
 *     declaration changes no answer, so it cannot be checked by anything, and a
 *     later re-tiering would silently start relying on it.
 *   • **Demotion on a type the tier already makes telemetry.** The same dead
 *     cover in the other direction — the tier answers telemetry with or without
 *     the row, so the row is a charter citation nothing exercises.
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

/** Split a derived map into its two sides. Never authored, never a literal list. */
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
