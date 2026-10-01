/**
 * Canonical serializer and read entry point for rehydration documents.
 * A prompt cache needs the same leading bytes in successive documents, so the serializer writes one key order:
 *
 *   1. `v`, the schema version discriminator
 *   2. `projectionSequence`, the projection log anchor
 *   3. the stable sections: `behavioralGuidance` (v:2 only), then `workflowState`
 *   4. the volatile section keys, in `VOLATILE_KEYS` order
 *
 * The `workflowState` sub-section follows the key order of its schema `.shape`.
 */
import { z } from 'zod';
import {
  RehydrationDocumentSchema,
  RehydrationDocumentSchemaV1,
  RehydrationDocumentSchemaV2,
  RehydrationDocumentSchemaV3,
  StableSectionsSchema,
  VolatileSectionsSchema,
  WorkflowStateSchema,
  type RehydrationDocument,
  type RehydrationDocumentV4,
} from './schema.js';
import {
  InvalidEnvelopeError,
  upgradeRehydrationDocument,
} from './upgrade.js';

/** Top-level stable section keys from `StableSectionsSchema.shape`, in schema order. */
export const STABLE_KEYS = Object.keys(StableSectionsSchema.shape) as ReadonlyArray<
  keyof typeof StableSectionsSchema.shape
>;

/**
 * The full stable prefix order of the serialized document: `v`, `projectionSequence`, then `STABLE_KEYS`.
 * `applyCacheHints` builds its cache-boundary `position` from this list.
 * Without the two leading keys, that boundary does not match the end of the stable bytes.
 */
export const STABLE_PREFIX_KEYS: ReadonlyArray<string> = [
  'v',
  'projectionSequence',
  ...STABLE_KEYS,
];

/**
 * Top-level volatile section keys, in canonical serialization order.
 */
export const VOLATILE_KEYS = Object.keys(VolatileSectionsSchema.shape) as ReadonlyArray<
  keyof typeof VolatileSectionsSchema.shape
>;

/**
 * Fixed inner key order for the v:2 `behavioralGuidance` sub-section.
 * A v:2 document serializes through this order, so its bytes stay deterministic.
 */
const BEHAVIORAL_GUIDANCE_KEYS = ['skill', 'skillRef', 'tools'] as const;

/** Inner key order for `workflowState`, from the `.shape` of its schema. */
const WORKFLOW_STATE_KEYS = Object.keys(WorkflowStateSchema.shape) as ReadonlyArray<
  keyof typeof WorkflowStateSchema.shape
>;

/**
 * Build a new object with the given key order. Keys absent on the source
 * are skipped (preserves optional-field semantics such as
 * `behavioralGuidance.tools` or `volatile.nextAction`).
 */
function reorder<T extends Record<string, unknown>>(
  source: T,
  keys: ReadonlyArray<keyof T & string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * Serializes a rehydration document to JSON in the canonical key order.
 * Equal field values give the same string, whatever key order the caller used.
 * Documents with equal stable fields share the same bytes through the last stable section, which is the prompt-cache prefix.
 * The static type has no v:2 member. A runtime check still keeps the v:2 `behavioralGuidance` sub-section when a caller passes a parsed v:2 payload.
 */
export function serializeRehydrationDocument(doc: RehydrationDocument): string {
  const ordered: Record<string, unknown> = {
    v: doc.v,
    projectionSequence: doc.projectionSequence,
  };

  const docAsRecord = doc as Record<string, unknown>;
  if (docAsRecord['v'] === 2 && docAsRecord['behavioralGuidance']) {
    ordered['behavioralGuidance'] = reorder(
      docAsRecord['behavioralGuidance'] as Record<string, unknown>,
      BEHAVIORAL_GUIDANCE_KEYS,
    );
  }
  ordered['workflowState'] = reorder(doc.workflowState, WORKFLOW_STATE_KEYS);

  for (const key of VOLATILE_KEYS) {
    const value = (doc as Record<string, unknown>)[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }

  return JSON.stringify(ordered);
}

/**
 * Probe schema for envelope-version routing — minimal `z.literal` union over
 * `v` that lets `loadRehydrationDocument` decide which full schema to apply.
 * Defined once at module scope so the compiled probe is shared across calls.
 */
const EnvelopeVersionProbe = z.object({
  v: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
});

/**
 * Read entry point for rehydration documents. It probes the `v` discriminator and always returns a v:4 document.
 * A `v: 4` input parses with the current schema.
 * A `v: 3`, `v: 2`, or `v: 1` input parses with its own schema, then `upgradeRehydrationDocument` upgrades it.
 * Any other input throws `InvalidEnvelopeError`. The caller must report that corruption as a workflow state.
 *
 * Writers do not call this function. They build v:4 documents with `RehydrationDocumentSchema`.
 */
export function loadRehydrationDocument(raw: unknown): RehydrationDocumentV4 {
  const probe = EnvelopeVersionProbe.safeParse(raw);
  if (!probe.success) {
    throw new InvalidEnvelopeError(probe.error);
  }
  switch (probe.data.v) {
    case 4:
      return RehydrationDocumentSchema.parse(raw);
    case 3:
      return upgradeRehydrationDocument(RehydrationDocumentSchemaV3.parse(raw));
    case 2:
      return upgradeRehydrationDocument(RehydrationDocumentSchemaV2.parse(raw));
    case 1:
      return upgradeRehydrationDocument(RehydrationDocumentSchemaV1.parse(raw));
  }
}
