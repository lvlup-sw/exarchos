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

export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
}

export interface ReservedEventAppendRegistration {
  readonly eventType: string;
  readonly typedHandler?: string;
}

/**
 * Server-owned admission event reservation catalog (DR-3).
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
