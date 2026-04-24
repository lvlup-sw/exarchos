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
import {
  BehavioralGuidanceSchema,
  StableSectionsSchema,
  VolatileSectionsSchema,
  WorkflowStateSchema,
  type RehydrationDocument,
} from './schema.js';

/**
 * Top-level stable section keys, in canonical serialization order.
 * Derived from `StableSectionsSchema.shape` so adding a stable field to the
 * schema (and only there) automatically threads through the serializer.
 */
export const STABLE_KEYS = Object.keys(StableSectionsSchema.shape) as ReadonlyArray<
  keyof typeof StableSectionsSchema.shape
>;

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
 */
export function serializeRehydrationDocument(doc: RehydrationDocument): string {
  const ordered: Record<string, unknown> = {
    v: doc.v,
    projectionSequence: doc.projectionSequence,
    behavioralGuidance: reorder(doc.behavioralGuidance, BEHAVIORAL_GUIDANCE_KEYS),
    workflowState: reorder(doc.workflowState, WORKFLOW_STATE_KEYS),
  };

  for (const key of VOLATILE_KEYS) {
    const value = (doc as Record<string, unknown>)[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }

  return JSON.stringify(ordered);
}
