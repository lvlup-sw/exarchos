// ─── The settlement bundle ───────────────────────────────────────────────────
//
// `settle` commits one ledger record and hands the caller one receipt. Neither
// carries the interior of the adjudication: which claim was read against which
// declared field, what evidence each cited, which deviation was proposed. That
// detail is what an auditor needs and what a projection must not fold, so it
// goes to the run-bundle store as content-addressed bytes and the ledger record
// names those bytes by digest — the same custody the executor's record already
// uses, through the same store.
//
// Strict throughout, and encoded as canonical JSON so one document always
// produces one digest. A writer that could emit any shape could also emit a
// shape no reader recognises, and two encodings of one document differing only
// by key order would be two artifacts.

import { z } from 'zod';

import { canonicalJson } from '../../contract/request-context.js';
import { ArtifactIdSchema, type ArtifactId } from '../../workflow/admission/types.js';
import { SETTLEMENT_FINDING_KINDS } from './adjudicate.js';

/** The `kind` discriminator every settlement bundle carries. */
export const SETTLEMENT_BUNDLE_KIND = 'settlement-adjudication';

/** The document version. Bumped when a reader of this shape could misread the next. */
export const SETTLEMENT_BUNDLE_VERSION = '1.0';

const FindingSchema = z
  .object({
    kind: z.enum(SETTLEMENT_FINDING_KINDS),
    subject: z.string().min(1),
    at: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const EvidenceSchema = z
  .object({ kind: z.string().min(1), ref: z.string().min(1) })
  .strict();

/**
 * One claim as it was adjudicated — the arguments the verdict was reached from,
 * not the ones that were asked for. `fields` is a record of `unknown` because
 * the capsule, not this schema, is what declares a task's result shape.
 */
const ClaimTraceSchema = z
  .object({
    taskId: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
    evidence: z.array(EvidenceSchema),
  })
  .strict();

const DeviationSchema = z
  .object({ deviationKind: z.string().min(1), statement: z.string().min(1) })
  .strict();

/**
 * The denominator, persisted. A bundle recording zero findings over zero claims
 * and one recording zero findings over forty are different facts, and only the
 * counts tell them apart after the run is over.
 */
const CensusSchema = z
  .object({
    claims: z.number().int().nonnegative(),
    requiredResults: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    deviations: z.number().int().nonnegative(),
  })
  .strict();

export const SettlementBundleV1Schema = z
  .object({
    bundleVersion: z.literal(SETTLEMENT_BUNDLE_VERSION),
    kind: z.literal(SETTLEMENT_BUNDLE_KIND),
    operationId: z.string().min(1),
    streamId: z.string().min(1),
    requestDigest: z.string().min(1),
    /** Which capsule was pinned, so a reader can recover the terms applied. */
    capsule: z
      .object({
        workflowId: z.string().min(1),
        definitionVersion: z.string().min(1),
        designVersion: z.string().min(1),
        capsuleVersion: z.number().int().min(1),
        batchId: z.string().min(1),
      })
      .strict(),
    outcome: z.enum(['settled', 'rejected', 'deviation-pending']),
    acceptedTasks: z.array(z.string().min(1)),
    findings: z.array(FindingSchema),
    claims: z.array(ClaimTraceSchema),
    deviations: z.array(DeviationSchema),
    adjudicated: CensusSchema,
    settledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type SettlementBundleV1 = z.infer<typeof SettlementBundleV1Schema>;

/**
 * The artifact identity carried beside the digest, built from the batch and the
 * capsule version so a reader holding a ledger record can name the bundle
 * without first resolving it. The store keys bytes by digest and never by this
 * id, so a collision here is a naming coincidence rather than a storage hazard.
 */
export function settlementBundleArtifactId(batchId: string, capsuleVersion: number): ArtifactId {
  return ArtifactIdSchema.parse(
    `run-bundle:${SETTLEMENT_BUNDLE_KIND}:${batchId}:${capsuleVersion}`,
  );
}

/**
 * Encode a document to the bytes the store will hash. Parsed through the schema
 * first, so a document the schema rejects never reaches custody: a digest of an
 * unreadable document is a reference nothing can follow.
 */
export function encodeSettlementBundle(document: SettlementBundleV1): Uint8Array {
  const validated = SettlementBundleV1Schema.parse(document);
  return Buffer.from(`${canonicalJson(validated)}\n`, 'utf8');
}

/**
 * Decode bytes recovered from the store. Throws on anything the schema does not
 * admit — a reader that tolerated a partial document would report facts the
 * producer never wrote.
 */
export function decodeSettlementBundle(bytes: Uint8Array): SettlementBundleV1 {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return SettlementBundleV1Schema.parse(parsed);
}
