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
 * ── Promotion only, never demotion ──────────────────────────────────────────
 *
 * A type whose tier derives `auto` is governance and stays governance, even
 * when nothing here is known to fold or read it. Only the other direction is
 * open: a witness may promote a non-`auto` type.
 *
 * The reason is about what the instruments can prove. A demotion asserts
 * "nothing depends on this event" — a universal claim. The fold measurement and
 * the raw-reader census are sufficient to justify a PROMOTION, because a single
 * observed fold or reader is a witness; their completeness is not yet proved,
 * and a static scanner has an acknowledged blind spot (a bare fold whose type
 * comparison happens in another module). So a gap in either instrument can only
 * make this map over-retain, never silently demote. Types that plainly look
 * like telemetry and derive `auto` — the tool and turn families among them —
 * are the demotion backlog, and closing it needs a stronger instrument than
 * this one.
 *
 * ── Fail-closed, and by name ────────────────────────────────────────────────
 *
 * Built like `deriveEmissionRegistry`: a pure function over an injected
 * population and an injected lookup, so a probe can derive over a seeded
 * catalog without touching the live tables, and every refusal NAMES its
 * offenders rather than reporting a count.
 */

import type { EmissionSource } from '../event-registration.js';

/** Whether anything depends on the event being present. */
export type EventAuthority = 'governance' | 'telemetry';

/** How a promotion is proved. */
export type AuthorityArm = 'projection-fold' | 'raw-reader' | 'charter-pin';

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
 * Partition a population of event types into governance and telemetry.
 *
 * The rule is one line and total: a type is `governance` iff its tier derives
 * `auto` OR it carries a witness; otherwise it is `telemetry`.
 *
 * Four refusals, each because the alternative is a map that reads clean while
 * saying nothing:
 *
 *   • **Empty population.** An empty map reads to every consumer as "no event
 *     has an authority", which is exactly what a moved or renamed catalog
 *     produces.
 *   • **Unannotated type.** No tier, no derivable authority. Defaulting it
 *     would be the guess this derivation exists to remove.
 *   • **Witness for a type outside the population.** A renamed or deleted event
 *     leaves its witness behind, still asserting a promotion for nothing.
 *   • **Witness on a type the tier already makes governance.** Dead cover: the
 *     declaration changes no answer, so it cannot be checked by anything, and a
 *     later re-tiering would silently start relying on it.
 */
export function deriveEventAuthority(
  eventTypes: Iterable<string>,
  tierSourceOf: (eventType: string) => EmissionSource | undefined,
  witnesses: Readonly<Record<string, AuthorityWitness>>,
): Record<string, EventAuthority> {
  const derived: Record<string, EventAuthority> = {};
  const unannotated: string[] = [];
  const deadCover: string[] = [];
  let population = 0;

  for (const eventType of eventTypes) {
    population += 1;
    const tierSource = tierSourceOf(eventType);
    if (tierSource === undefined) {
      unannotated.push(eventType);
      continue;
    }
    const witness = witnesses[eventType];
    if (tierSource === 'auto') {
      if (witness !== undefined) deadCover.push(eventType);
      derived[eventType] = 'governance';
      continue;
    }
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

  const stale = Object.keys(witnesses).filter((eventType) => derived[eventType] === undefined);
  if (stale.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${stale.length} governance witness(es) name an event type that is ` +
        `not in the population: ${stale.sort().join(', ')}. A witness for a renamed or deleted ` +
        'type promotes nothing and must be removed with the type.',
    );
  }
  if (deadCover.length > 0) {
    throw new Error(
      `deriveEventAuthority: ${deadCover.length} governance witness(es) cover a type whose tier ` +
        `already derives governance: ${deadCover.sort().join(', ')}. The declaration changes no ` +
        'answer, so nothing can check it — delete it, or re-tier the event if the tier is wrong.',
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
