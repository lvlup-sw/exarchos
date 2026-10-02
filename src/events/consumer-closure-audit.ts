/**
 * Checks that every declared consumer exists.
 *
 * The `consumedBy` field of a capability or harness registration is an open
 * `string` reference. This layer cannot import every projection to enumerate the
 * real names, so a `consumedBy` entry can name a deleted reducer.
 *
 * The check is a pure function over a population that the caller injects. The
 * caller sits in a layer that can import the projections.
 */

import { EVENT_ANNOTATIONS } from './event-annotations.js';
import type { EventRegistration } from './event-registration.js';

/** A `consumedBy` entry naming a consumer the live population does not contain. */
export interface UnresolvedConsumerRef {
  readonly code: 'UNRESOLVED_CONSUMER_REF';
  readonly event: string;
  readonly tier: 'capability' | 'harness';
  readonly consumer: string;
  readonly message: string;
}

export interface ConsumerClosureResult {
  /** Every declared consumer resolves, over a non-empty population. */
  readonly ok: boolean;
  /** Registrations carrying a `consumedBy` — the DENOMINATOR. */
  readonly rowsWithConsumers: number;
  /** Distinct consumer names referenced across those rows. */
  readonly referencedConsumerCount: number;
  /** Size of the injected live population, echoed so a caller cannot not look. */
  readonly livePopulationSize: number;
  readonly unresolved: readonly UnresolvedConsumerRef[];
}

/**
 * Reconcile every declared `consumedBy` against the live consumer population.
 * It returns a verdict and never throws.
 *
 * An empty `liveConsumers` fails every referenced row. An audit with no
 * population measured nothing, so it must not report a clean tree.
 */
export function auditConsumerClosure(
  liveConsumers: ReadonlySet<string>,
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
): ConsumerClosureResult {
  const unresolved: UnresolvedConsumerRef[] = [];
  const referenced = new Set<string>();
  let rowsWithConsumers = 0;

  for (const [event, registration] of Object.entries(annotations)) {
    if (registration.tier !== 'capability' && registration.tier !== 'harness') continue;
    rowsWithConsumers += 1;
    for (const consumer of registration.consumedBy) {
      referenced.add(consumer);
      if (liveConsumers.has(consumer)) continue;
      unresolved.push({
        code: 'UNRESOLVED_CONSUMER_REF',
        event,
        tier: registration.tier,
        consumer,
        message:
          `'${event}' declares that '${consumer}' consumes it, and no live reducer or view ` +
          'carries that name. The consumer was deleted or renamed and the registration outlived ' +
          "it — the row now asserts a fold that does not happen. Re-point the reference or " +
          'retire the registration; a consumer nothing resolves is a report wearing a weld.',
      });
    }
  }

  const byRef = (a: UnresolvedConsumerRef, b: UnresolvedConsumerRef): number =>
    a.event.localeCompare(b.event) || a.consumer.localeCompare(b.consumer);

  return Object.freeze({
    ok: unresolved.length === 0 && liveConsumers.size > 0,
    rowsWithConsumers,
    referencedConsumerCount: referenced.size,
    livePopulationSize: liveConsumers.size,
    unresolved: Object.freeze([...unresolved].sort(byRef)),
  });
}
