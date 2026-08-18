/**
 * Does a registration's `provider` name the area the event is actually
 * appended from?
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 *
 * `provider` is defined as the effect provider that APPENDS the event, and a
 * provider is a tool bound to an area of the tree (`exarchos_orchestrate →
 * verbs/`). The existing provider comparison checks the declared provider
 * against the DECLARING TOOL — one declaration against another — and never
 * looks at where the append happens.
 *
 * That leaves two failures indistinguishable from health. A provider naming the
 * wrong area produces no diagnostic at all. And a reported disagreement can be
 * "repaired" by adopting the declaring tool, which buys agreement while
 * asserting an append site that does not exist — the comparison agreeing with
 * itself rather than with the tree.
 *
 * Measuring the append site makes the provider claim falsifiable against
 * something that is not another declaration.
 *
 * ── Absence is its own answer ───────────────────────────────────────────────
 *
 * An event with no measured append site is NOT reported as a mismatch. It is
 * counted, separately, because the two readings have opposite remedies: a
 * `planned` registration correctly has no emitter, while an `active` one with
 * no measured site means either the census could not read the append or nothing
 * performs it. Folding those into the mismatch arm would put an unanswerable
 * finding next to an actionable one under the same name.
 *
 * The counts ride the result for the reason every denominator in this codebase
 * does: a check that examined nothing publishes exactly the shape of a check
 * that examined everything and found it clean.
 */

import type { AppendSiteCensus } from './append-site-census.js';
import type { EventRegistration } from './event-registration.js';
import { EVENT_ANNOTATIONS } from './event-annotations.js';
import {
  EFFECT_PROVIDERS,
  type EffectProvider,
} from '../contract/reachability/providers.js';

/** The one fault this audit reports. */
export interface ProviderAreaMismatch {
  readonly code: 'PROVIDER_AREA_MISMATCH';
  readonly event: string;
  /** The provider the registration declares. */
  readonly declaredProvider: string;
  /** The area that provider is bound to. */
  readonly declaredArea: string;
  /** Measured append modules that lie outside {@link declaredArea}. */
  readonly foreignModules: readonly string[];
  readonly message: string;
}

/** An `active` capability registration the census found no append site for. */
export interface UnmeasuredEmission {
  readonly event: string;
  readonly declaredProvider: string;
}

export interface ProviderAreaAuditResult {
  /** No capability registration names an area its event is appended outside of. */
  readonly ok: boolean;
  /** Capability registrations with a resolvable provider — the SUBJECT population. */
  readonly subjectCount: number;
  /** Of those, how many the census measured at least one append site for. */
  readonly measuredCount: number;
  /** `active` subjects with no measured append site. Counted, never a mismatch. */
  readonly unmeasured: readonly UnmeasuredEmission[];
  readonly diagnostics: readonly ProviderAreaMismatch[];
}

/** The area a provider id is bound to, or `undefined` when the id resolves to no provider. */
function areaOf(
  provider: string,
  providers: readonly EffectProvider[],
): string | undefined {
  return providers.find((entry) => entry.tool === provider)?.area;
}

/**
 * Compare every capability registration's declared provider area against the
 * measured append sites for its event. Pure and total: returns a verdict,
 * never throws.
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
  const diagnostics: ProviderAreaMismatch[] = [];
  const unmeasured: UnmeasuredEmission[] = [];
  let subjectCount = 0;
  let measuredCount = 0;

  for (const [event, registration] of Object.entries(annotations)) {
    if (registration.tier !== 'capability') continue;
    const declaredArea = areaOf(registration.provider, providers);
    // An id that resolves to no provider is the weld gate's fault to report,
    // not this one's. Two checks naming the same defect make the second look
    // like corroboration when it is an echo.
    if (declaredArea === undefined) continue;
    subjectCount += 1;

    const modules = census.modulesByEvent.get(event) ?? [];
    if (modules.length === 0) {
      if (registration.lifecycle === 'active') {
        unmeasured.push({ event, declaredProvider: registration.provider });
      }
      continue;
    }
    measuredCount += 1;

    const foreignModules = modules.filter((module) => !module.startsWith(declaredArea));
    if (foreignModules.length === 0) continue;

    diagnostics.push({
      code: 'PROVIDER_AREA_MISMATCH',
      event,
      declaredProvider: registration.provider,
      declaredArea,
      foreignModules,
      message:
        `event '${event}' is registered with provider '${registration.provider}', whose area is ` +
        `'${declaredArea}', but it is appended from ${foreignModules.map((m) => `'${m}'`).join(', ')}. ` +
        'A provider names the effect area that performs the append, so one of the two is wrong: ' +
        'either the annotation names the wrong provider, or the append belongs in the area the ' +
        'annotation claims. Adopting whichever tool happens to route the call would satisfy the ' +
        'tool-against-tool comparison while leaving this one reporting, which is the point of ' +
        'measuring the site rather than reading a second declaration.',
    });
  }

  const sorted = [...diagnostics].sort((a, b) => a.event.localeCompare(b.event));
  return Object.freeze({
    ok: sorted.length === 0,
    subjectCount,
    measuredCount,
    unmeasured: Object.freeze(unmeasured.sort((a, b) => a.event.localeCompare(b.event))),
    diagnostics: Object.freeze(sorted),
  });
}
