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
 * v:2 read-back inner key order for the now-removed `behavioralGuidance`
 * sub-section. Hardcoded (T-50) since `BehavioralGuidanceSchema` was deleted;
 * any v:2 snapshot still on disk is normalized through this fixed order so
 * serialization remains byte-deterministic during the v:2 → v:3 upgrade path.
 */
const BEHAVIORAL_GUIDANCE_KEYS = ['skill', 'skillRef', 'tools'] as const;

/**
 * Inner key order for stable sub-sections, derived from sub-schema `.shape` so
 * the serializer tracks schema declaration order.
 */
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

  // v:2 had behavioralGuidance in stable sections; v:3 and v:4 do not.
  // The public `RehydrationDocument` union is now v:3 | v:4 so the
  // behavioralGuidance branch is unreachable through the static type
  // surface. The runtime check below guards callers that pass a freshly
  // parsed v:2 envelope through this serializer (e.g. migration tooling
  // that operates on `unknown` payloads — see CodeRabbit on PR #1178)
  // without forcing the type union to widen back to v:2.
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
 * Read entry point for rehydration documents — T-03
 * (rehydration-machinery-refactor) / T3 (#1246-readside-migration).
 *
 * Probes the input envelope's `v` discriminator and routes all versions to
 * the current v:3 shape via the upgrade chain:
 *   - `v: 3` → full v:3 schema parse, returned as-is (native pass-through).
 *   - `v: 2` → full v:2 schema parse, then `upgradeRehydrationDocument`
 *     to produce a strict-mode-valid v:3 document.
 *   - `v: 1` → full v:1 schema parse, then `upgradeRehydrationDocument`
 *     which chains v:1 → v:2 → v:3 with per-entry fail-open on handoff entries.
 *   - none of the above → `InvalidEnvelopeError` (no silent fallback per DR-18).
 *     The caller is responsible for surfacing corruption as a workflow state.
 *
 * Always returns `RehydrationDocumentV3`. Writers MUST NOT call this — they
 * construct v:3 documents directly via `RehydrationDocumentSchema`. This is
 * the only legitimate path that touches `RehydrationDocumentSchemaV1` and
 * `RehydrationDocumentSchemaV2`.
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
