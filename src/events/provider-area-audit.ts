/**
 * Is a registration's `provider` claim consistent with where the event is
 * actually appended?
 *
 * ── What `provider` means, and what this may therefore conclude ─────────────
 *
 * A provider's IDENTITY is its composite tool (`event-registration.ts` says so
 * outright), and each provider is bound to the area whose filesystem effects it
 * owns — `exarchos_orchestrate → verbs/`. A tool dispatches into modules well
 * beyond its own area, so "the append is outside the declared provider's area"
 * is NOT by itself a fault. `review.routed` is appended from `review/` by an
 * action registered on `exarchos_orchestrate`; that is a tool reaching its own
 * callee, not a wrong annotation.
 *
 * So this audit deliberately does not draw that conclusion. It reports the two
 * things the measurement can actually support:
 *
 *   • {@link ProviderAreaContradiction} — the append happens inside a DIFFERENT
 *     provider's area. Two providers cannot both own one append, so exactly one
 *     of the two claims is false. This is a fault.
 *
 *   • {@link UngovernedAppendArea} — the append happens in an area no provider
 *     owns at all. Not a contradiction: it is the absence of a claim, and no
 *     annotation over the current vocabulary could be right, because the
 *     vocabulary has no name for that area. This is the structural gap, and it
 *     is reported so its size is a number rather than an impression.
 *
 * Separating them matters because the remedies are opposites. A contradiction
 * is repaired by correcting one side. An ungoverned append is repaired by
 * widening the model or moving the append — and "fixing" it by picking whatever
 * tool routes the call would assert an append site that does not exist, which
 * is the comparison agreeing with itself rather than with the tree.
 *
 * ── Absence is its own answer ───────────────────────────────────────────────
 *
 * An event with no measured append site is counted, never reported as a fault.
 * A `planned` registration correctly has no emitter; an `active` one with no
 * measured site means either nothing performs it or the census could not read
 * it. Both are unanswerable here and neither belongs beside an actionable
 * finding under the same name.
 */

import type { AppendSiteCensus } from './append-site-census.js';
import type { EventRegistration } from './event-registration.js';
import { EVENT_ANNOTATIONS } from './event-annotations.js';
import {
  EFFECT_PROVIDERS,
  type EffectProvider,
} from '../contract/reachability/providers.js';

/** The append lands inside an area a DIFFERENT provider owns. Exactly one claim is false. */
export interface ProviderAreaContradiction {
  readonly code: 'PROVIDER_AREA_CONTRADICTION';
  readonly event: string;
  readonly declaredProvider: string;
  /** The module performing the append. */
  readonly module: string;
  /** The provider that owns the area the append is in. */
  readonly owningProvider: string;
  readonly message: string;
}

/** The append lands in an area no provider owns, so no annotation could be right. */
export interface UngovernedAppendArea {
  readonly code: 'UNGOVERNED_APPEND_AREA';
  readonly event: string;
  readonly declaredProvider: string;
  readonly module: string;
  readonly message: string;
}

/** An `active` capability registration the census found no append site for. */
export interface UnmeasuredEmission {
  readonly event: string;
  readonly declaredProvider: string;
}

export interface ProviderAreaAuditResult {
  /** No contradiction was found. Ungoverned appends do NOT clear this flag — see below. */
  readonly ok: boolean;
  /** Capability registrations with a resolvable provider — the SUBJECT population. */
  readonly subjectCount: number;
  /** Of those, how many the census measured at least one append site for. */
  readonly measuredCount: number;
  readonly unmeasured: readonly UnmeasuredEmission[];
  /** Definite faults: one of the two claims is false. */
  readonly contradictions: readonly ProviderAreaContradiction[];
  /**
   * The structural gap, reported rather than judged. Kept OFF {@link ok} on
   * purpose: an ungoverned append is not something the annotator did wrong, and
   * failing on it would demand a repair the vocabulary cannot express.
   */
  readonly ungoverned: readonly UngovernedAppendArea[];
}

/** The provider that owns the area `module` sits in, if any. */
function owningProviderOf(
  module: string,
  providers: readonly EffectProvider[],
): EffectProvider | undefined {
  // Longest area first, so `projections/views/` wins over a hypothetical
  // `projections/` rather than depending on declaration order.
  return [...providers]
    .sort((a, b) => b.area.length - a.area.length)
    .find((provider) => module.startsWith(provider.area));
}

/**
 * Compare every capability registration's provider against the measured append
 * sites for its event. Pure and total: returns a verdict, never throws.
 *
 * Every population is a parameter with a live default, following the rest of
 * this layer: an audit that could only read one hard-wired input could not be
 * shown to be capable of reporting anything.
 */
export function auditProviderAreas(
  census: AppendSiteCensus,
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
): ProviderAreaAuditResult {
  const contradictions: ProviderAreaContradiction[] = [];
  const ungoverned: UngovernedAppendArea[] = [];
  const unmeasured: UnmeasuredEmission[] = [];
  let subjectCount = 0;
  let measuredCount = 0;

  for (const [event, registration] of Object.entries(annotations)) {
    if (registration.tier !== 'capability') continue;
    const declared = providers.find((entry) => entry.tool === registration.provider);
    // An id naming no provider is the weld gate's finding. Reporting it here as
    // well would make an echo look like corroboration.
    if (declared === undefined) continue;
    subjectCount += 1;

    const modules = census.modulesByEvent.get(event) ?? [];
    if (modules.length === 0) {
      if (registration.lifecycle === 'active') {
        unmeasured.push({ event, declaredProvider: registration.provider });
      }
      continue;
    }
    measuredCount += 1;

    for (const module of modules) {
      if (module.startsWith(declared.area)) continue;
      const owner = owningProviderOf(module, providers);
      if (owner === undefined) {
        ungoverned.push({
          code: 'UNGOVERNED_APPEND_AREA',
          event,
          declaredProvider: registration.provider,
          module,
          message:
            `event '${event}' is appended from '${module}', which lies in no provider's area. ` +
            'The registration names a provider because every capability event is welded to one, ' +
            'but no value in the current vocabulary describes this append site, so the annotation ' +
            'cannot be made right by editing it. Either the append belongs in a governed area, or ' +
            'the model needs a way to name an emitter that is not one of the five composite tools.',
        });
        continue;
      }
      contradictions.push({
        code: 'PROVIDER_AREA_CONTRADICTION',
        event,
        declaredProvider: registration.provider,
        module,
        owningProvider: owner.tool,
        message:
          `event '${event}' is registered with provider '${registration.provider}' (area ` +
          `'${declared.area}'), but it is appended from '${module}', which is inside ` +
          `'${owner.area}' — the area owned by '${owner.tool}'. Two providers cannot both own one ` +
          'append, so exactly one of the two claims is false: either the annotation names the ' +
          'wrong provider, or the append belongs in the area the annotation claims.',
      });
    }
  }

  const byEvent = (a: { event: string }, b: { event: string }): number =>
    a.event.localeCompare(b.event);
  return Object.freeze({
    ok: contradictions.length === 0,
    subjectCount,
    measuredCount,
    unmeasured: Object.freeze([...unmeasured].sort(byEvent)),
    contradictions: Object.freeze([...contradictions].sort(byEvent)),
    ungoverned: Object.freeze([...ungoverned].sort(byEvent)),
  });
}
