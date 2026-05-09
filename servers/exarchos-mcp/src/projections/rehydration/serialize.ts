/**
 * Canonical rehydration document serializer — T050 (DR-14).
 *
 * Prompt-cache friendliness requires byte-identical leading bytes across
 * successive rehydration documents. This module enforces a single canonical
 * key order at serialization time:
 *
 *   1. `v`                    — schema version discriminator
 *   2. `projectionSequence`   — projection log anchor
 *   3. stable section keys    — in the order declared by `STABLE_KEYS`
 *   4. volatile section keys  — in the order declared by `VOLATILE_KEYS`
 *
 * Nested stable sub-sections (behavioralGuidance, workflowState) also walk
 * their schema `.shape` so inner key order is stable across callers.
 *
 * `STABLE_KEYS` and `VOLATILE_KEYS` are exported so downstream tasks (T051:
 * conditional `cache_control` markers) can segment the document without
 * duplicating the ordering policy.
 */
import { z } from 'zod';
import {
  BehavioralGuidanceSchema,
  RehydrationDocumentSchema,
  RehydrationDocumentSchemaV1,
  StableSectionsSchema,
  VolatileSectionsSchema,
  WorkflowStateSchema,
  type RehydrationDocument,
} from './schema.js';
import {
  InvalidEnvelopeError,
  upgradeRehydrationDocumentV1toV2,
} from './upgrade.js';

/**
 * Top-level stable section keys, in canonical serialization order.
 * Derived from `StableSectionsSchema.shape` so adding a stable field to the
 * schema (and only there) automatically threads through the serializer.
 */
export const STABLE_KEYS = Object.keys(StableSectionsSchema.shape) as ReadonlyArray<
  keyof typeof StableSectionsSchema.shape
>;

/**
 * Full stable prefix order, as it appears in the serialized document. Includes
 * the top-level discriminators (`v`, `projectionSequence`) that lead the
 * canonical layout but are not part of `StableSectionsSchema`.
 *
 * The cache-boundary `position` string emitted by `applyCacheHints`
 * (DR-14) reads from this constant — without `v` and `projectionSequence` the
 * advertised boundary would lie about where the stable bytes actually end
 * (sentry[bot] PR #1178#discussion_r3142469093).
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
 * Inner key order for each stable sub-section, derived from the sub-schemas'
 * `.shape` so the serializer tracks schema declaration order.
 */
const BEHAVIORAL_GUIDANCE_KEYS = Object.keys(BehavioralGuidanceSchema.shape) as ReadonlyArray<
  keyof typeof BehavioralGuidanceSchema.shape
>;
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
 * Serialize a rehydration document to JSON with canonical key order.
 *
 * The returned string is deterministic for equal field values regardless of
 * the caller's object-literal key-declaration order. The byte range up through
 * the last stable section is guaranteed to be identical for documents whose
 * stable fields match — which is the prompt-cache prefix invariant.
 *
 * Handles both v:2 (with `behavioralGuidance` in stable section) and v:3
 * (without `behavioralGuidance`; `phasePlaybook` in volatile section).
 * Full v:3 serialization is wired by T-05.
 */
export function serializeRehydrationDocument(doc: RehydrationDocument): string {
  const ordered: Record<string, unknown> = {
    v: doc.v,
    projectionSequence: doc.projectionSequence,
  };

  // v:2 has behavioralGuidance in stable sections; v:3 does not.
  if (doc.v === 2) {
    ordered['behavioralGuidance'] = reorder(
      doc.behavioralGuidance,
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
  v: z.union([z.literal(1), z.literal(2)]),
});

/**
 * Read entry point for rehydration documents — T3 (#1246-readside-migration).
 *
 * Probes the input envelope's `v` discriminator and routes:
 *   - `v: 2` → full v:2 schema parse, returned as-is.
 *   - `v: 1` → full v:1 schema parse, then `upgradeRehydrationDocumentV1toV2`
 *     to produce a strict-mode-valid v:2 document with per-entry fail-open.
 *   - neither → `InvalidEnvelopeError` (no silent fallback per DR-18). The
 *     caller is responsible for surfacing corruption as a workflow state.
 *
 * Writers MUST NOT call this — they construct v:2 documents directly via
 * `RehydrationDocumentSchema`. This is the only legitimate path that touches
 * `RehydrationDocumentSchemaV1`.
 */
export function loadRehydrationDocument(raw: unknown): RehydrationDocument {
  const probe = EnvelopeVersionProbe.safeParse(raw);
  if (!probe.success) {
    throw new InvalidEnvelopeError(probe.error);
  }
  if (probe.data.v === 2) {
    return RehydrationDocumentSchema.parse(raw);
  }
  const v1doc = RehydrationDocumentSchemaV1.parse(raw);
  return upgradeRehydrationDocumentV1toV2(v1doc);
}
