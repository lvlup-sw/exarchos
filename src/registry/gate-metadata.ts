import {
  INTERNAL_ADMISSION_EVENT_TYPES,
  INTERNAL_CANCELLATION_EVENT_TYPES,
  INTERNAL_EXECUTION_LEDGER_EVENT_TYPES,
  INTERNAL_VCS_LEDGER_EVENT_TYPES,
} from '../events/schemas.js';
import type { SupportedGateClass } from '../verbs/gates/gate-provider-registry.js';

export interface GateMetadata {
  readonly blocking: boolean;
  readonly dimension?: string;
  /**
   * Shared mechanical gate identity owned by the provider registry. Most
   * quality gates intentionally have no GateClass and remain unchanged.
   */
  readonly gateClass?: SupportedGateClass;
}

/**
 * The edge that a declaration is in the emission coupling of an event. The `primary` edge is the
 * action that emits the event under its `condition`. A `recovery` edge is a second, time-boxed
 * path that backs up a primary that did not fire.
 */
export type AutoEmissionRole = 'primary' | 'recovery';

export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
  /**
   * The edge that this declaration is, read as declared. It is optional, because an edge can leave
   * it out. This module never infers a role, so an edge with no `role` is undeclared, not `primary`.
   */
  readonly role?: AutoEmissionRole;
  /** The team or module accountable for this emission edge, read as declared. */
  readonly owner?: string;
  /**
   * ISO-8601 timestamp after which a `role: 'recovery'` edge is expired. Only a recovery edge uses
   * it, because a `primary` edge has no time box.
   */
  readonly recoveryExpiresAt?: string;
}

/** The verdict from {@link validateAutoEmission}. */
export interface AutoEmissionValidation {
  readonly ok: boolean;
  /** Present only when `ok` is `false`. */
  readonly reason?: string;
}

/**
 * Validates the recovery expiry of one `AutoEmission` declaration. A `role: 'recovery'` edge fails
 * when its `recoveryExpiresAt` does not parse or is not in the future. Every other edge passes,
 * including a recovery edge with no expiry.
 */
export function validateAutoEmission(
  emission: AutoEmission,
  now: Date = new Date(),
): AutoEmissionValidation {
  if (emission.role !== 'recovery' || emission.recoveryExpiresAt === undefined) {
    return { ok: true };
  }
  const expiry = new Date(emission.recoveryExpiresAt);
  const owner = emission.owner ?? '<unowned>';
  if (Number.isNaN(expiry.getTime())) {
    return {
      ok: false,
      reason:
        `recovery edge for '${emission.event}' owned by '${owner}' carries an unparsable ` +
        `recoveryExpiresAt ('${emission.recoveryExpiresAt}')`,
    };
  }
  if (expiry.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason:
        `recovery edge for '${emission.event}' owned by '${owner}' expired at ` +
        `${emission.recoveryExpiresAt}`,
    };
  }
  return { ok: true };
}

export interface ReservedEventAppendRegistration {
  readonly eventType: string;
  readonly typedHandler?: string;
}

/**
 * The server-owned catalog of reserved admission event types. It controls which untrusted write
 * surfaces can mint a fact. `EVENT_EMISSION_REGISTRY` is separate, and it classifies replay and
 * emission.
 *
 * An entry has a typed handler name only when that handler ships. Other reserved types have no
 * handler, so callers cannot invoke them.
 */
export const RESERVED_EVENT_APPEND_REGISTRY: ReadonlyMap<
  string,
  ReservedEventAppendRegistration
> = new Map(
  [
    ...INTERNAL_ADMISSION_EVENT_TYPES,
    ...INTERNAL_CANCELLATION_EVENT_TYPES,
    ...INTERNAL_VCS_LEDGER_EVENT_TYPES,
    ...INTERNAL_EXECUTION_LEDGER_EVENT_TYPES,
  ].map((eventType) => [
    eventType,
    {
      eventType,
      ...(eventType === 'admission.disagreement-disposition'
        ? { typedHandler: 'handleAdmissionDisagreementDisposition' }
        : {}),
    },
  ]),
);

export function getReservedEventAppendRegistration(
  eventType: string,
): ReservedEventAppendRegistration | undefined {
  return RESERVED_EVENT_APPEND_REGISTRY.get(eventType);
}
