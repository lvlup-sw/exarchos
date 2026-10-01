/**
 * Checks that the `provider` claim of a registration agrees with where the event
 * is appended.
 *
 * A provider is a composite tool, and it owns one area of the tree. A tool can
 * call modules outside its area, so an append outside the declared area is not a
 * fault by itself. The audit reports two findings:
 *   • {@link ProviderAreaContradiction}: the append is inside the area of a
 *     different provider, so one of the two claims is false.
 *   • {@link UngovernedAppendArea}: no provider owns the area. This is a gap in
 *     the vocabulary, not an annotation error.
 *
 * An event with no measured append site is counted, never reported as a fault.
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

/** The append lands in an area no provider owns, so no annotation can be right. */
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
  /** No contradiction was found. Ungoverned appends do not affect this flag. */
  readonly ok: boolean;
  /** Capability registrations with a resolvable provider — the SUBJECT population. */
  readonly subjectCount: number;
  /** Of those, how many the census measured at least one append site for. */
  readonly measuredCount: number;
  readonly unmeasured: readonly UnmeasuredEmission[];
  /** Definite faults: one of the two claims is false. */
  readonly contradictions: readonly ProviderAreaContradiction[];
  /**
   * The structural gap, reported and not judged. It does not affect {@link ok},
   * because the vocabulary cannot express a repair for an ungoverned append.
   */
  readonly ungoverned: readonly UngovernedAppendArea[];
}

/**
 * The provider that owns the area `module` sits in, if any. The longest area
 * wins, so the result does not depend on declaration order.
 */
function owningProviderOf(
  module: string,
  providers: readonly EffectProvider[],
): EffectProvider | undefined {
  return [...providers]
    .sort((a, b) => b.area.length - a.area.length)
    .find((provider) => module.startsWith(provider.area));
}

/**
 * Compare the provider of every capability registration against the measured
 * append sites for its event. It returns a verdict and never throws.
 *
 * Every population is a parameter with a live default, so a test can show that
 * the audit reports findings. An id that names no provider is skipped, because
 * the weld gate reports it.
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
