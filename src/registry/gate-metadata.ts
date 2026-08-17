import { INTERNAL_ADMISSION_EVENT_TYPES, INTERNAL_CANCELLATION_EVENT_TYPES } from '../events/schemas.js';
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
 * Which edge in an event's emission coupling a declaration is: the `primary`
 * edge is the action expected to emit the event under its stated
 * `condition`; a `recovery` edge is a second, time-boxed path that exists
 * only to backstop a primary that failed to fire.
 */
export type AutoEmissionRole = 'primary' | 'recovery';

export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
  /**
   * Which edge this declaration is, read verbatim from the declaration
   * itself. Optional: the live emission edges under `src/registry/actions/`
   * are migrated onto this field incrementally, so leaving it undeclared
   * must keep compiling. Nothing in this module infers a role from an
   * edge's name, its position among sibling edges, or the file it is
   * declared in — an edge with no `role` is simply undeclared, not
   * defaulted to `primary`.
   */
  readonly role?: AutoEmissionRole;
  /**
   * The team or module accountable for this emission edge, read verbatim
   * from the declaration. Optional for the same migration reason as
   * `role`.
   */
  readonly owner?: string;
  /**
   * ISO-8601 timestamp after which a `role: 'recovery'` edge is treated as
   * expired. Only meaningful on the recovery arm — a `primary` edge is not
   * a time-boxed backstop and carries no expiry.
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
 * Validate one `AutoEmission` declaration's recovery-expiry contract.
 *
 * This checks exactly one thing: whether a declared `recoveryExpiresAt` on
 * a `role: 'recovery'` edge has lapsed. A `primary` edge, an edge with no
 * `role`, or a recovery edge that carries no expiry all pass unconditionally
 * — there is nothing here to validate against. `emission.role` is read
 * exactly as declared; this function does not assign, default, or infer it.
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
 * Server-owned admission event reservation catalog.
 *
 * This is intentionally separate from EVENT_EMISSION_REGISTRY: that registry
 * describes replay/emission classification, while this one controls which
 * untrusted write surfaces may mint a fact. A typed handler name is present
 * only when v2.12 actually ships that handler; planned v3 actions remain
 * reserved without pretending that callers can invoke them.
 */
export const RESERVED_EVENT_APPEND_REGISTRY: ReadonlyMap<
  string,
  ReservedEventAppendRegistration
> = new Map(
  [...INTERNAL_ADMISSION_EVENT_TYPES, ...INTERNAL_CANCELLATION_EVENT_TYPES].map((eventType) => [
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

// ─── Action Annotations (#1289, design §2.4) ─────────────────────────
//
// Per-action metadata co-located with the schema. `safety` is
// server-trusted (consumed by HSM guards + computeNextActions in a
// later task). The 4 *Hint flags are spec-defined client-untrusted UI
// hints populated to tools/list. Per MCP §Tools / Annotations,
// annotations are EXPLICITLY untrusted by clients unless the server is
// trusted — they are advisory only on the wire.
