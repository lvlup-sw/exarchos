/**
 * Is every declared consumer a consumer that exists?
 *
 * `CapabilityRegistration.consumedBy` and `HarnessRegistration.consumedBy` are
 * open references: `ConsumerId` stayed `string` because its population is
 * `ProjectionReducer.id` plus the view-projection names, and enumerating those
 * FROM this layer means importing every projection — a layering inversion
 * `event-registration.ts` records and refuses. The non-empty tuple stops an
 * EMPTY consumer list from compiling; nothing stops a consumer list from
 * naming a reducer that was deleted. A registration like that still boots, and
 * its `consumedBy` reads as a live fold while pointing at nothing — the same
 * stale-cover shape the emitter-closure audit refuses on the emission side.
 *
 * So the check is a pure function over an INJECTED population. The annotation
 * table is read here, where it lives; the live consumer names are supplied by
 * the caller, which can sit in a layer that is allowed to import the
 * projections. The function never guesses at the population — an empty one is
 * reported as its own fault, because "checked every row against nothing" and
 * "every row resolves" are different answers.
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
 * Pure and total: returns a verdict, never throws.
 *
 * An empty `liveConsumers` fails every referenced row rather than none —
 * fail-closed, because an audit handed no population has measured nothing and
 * must not say the tree is clean.
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
