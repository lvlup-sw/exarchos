/**
 * The settlement bundle: the detail of one `settle` adjudication.
 *
 * The ledger record and the receipt do not carry the claims or the evidence
 * that each claim cited. An auditor needs that detail, and a projection must
 * not fold it. So it goes to the run-bundle store as content-addressed bytes,
 * and the ledger record names the bytes by digest.
 *
 * The schemas are strict. The encoding is canonical JSON, so one document
 * always gives one digest.
 */

import { z } from 'zod';

import { canonicalJson } from '../../contract/request-context.js';
import { BundleRefV1Schema } from '../../events/bundle/digest-references.js';
import { ArtifactIdSchema, type ArtifactId } from '../../workflow/admission/types.js';
import { SETTLEMENT_FINDING_KINDS } from './adjudicate.js';

/** The `kind` discriminator every settlement bundle carries. */
export const SETTLEMENT_BUNDLE_KIND = 'settlement-adjudication';

/** The document version. Change it when a reader of this shape can misread the next shape. */
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
 * One claim as adjudicated: the arguments that the verdict came from. `fields`
 * is a record of `unknown` because the capsule declares the result shape.
 */
const ClaimTraceSchema = z
  .object({
    taskId: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
    evidence: z.array(EvidenceSchema),
  })
  .strict();

/**
 * One deviation as the batch carried it, in the normal form that its id hashes. The two optional
 * fields have no bound here. The request bounds them, and a stored batch must always decode.
 */
const DeviationSchema = z
  .object({
    deviationKind: z.string().min(1),
    statement: z.string().min(1),
    affectedTasks: z.array(z.string().min(1)).optional(),
    proposedChange: z.string().min(1).optional(),
  })
  .strict();

/** One decision a decision round carried, as it was applied. */
const DecisionSchema = z
  .object({
    deviationId: z.string().min(1),
    decision: z.enum(['accepted', 'rejected']),
    actor: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

/**
 * The persisted denominator. Zero findings over zero claims and zero findings
 * over forty claims are different facts. After the run, only these counts tell
 * them apart.
 */
const CensusSchema = z
  .object({
    claims: z.number().int().nonnegative(),
    requiredResults: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    deviations: z.number().int().nonnegative(),
    /** Absent only on a bundle written before settlement verified anything. */
    verification: z.number().int().nonnegative().optional(),
    /** Absent only on a bundle written before held batches took decisions. */
    decisions: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * How the verification of one accepted claim ran. The segment detail is in its
 * own bundle, named by `bundleRefs`. This trace records only how the
 * settlement read it.
 */
const VerificationTraceSchema = z
  .object({
    taskId: z.string().min(1),
    outcome: z.enum(['verified', 'already-complete', 'failed']),
    operationId: z.string().min(1).optional(),
    failedLeaf: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    bundleRefs: z.array(BundleRefV1Schema).min(1).optional(),
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
    /**
     * The decisions this round applied. It is empty on the round that submitted
     * the batch, and absent only on a bundle written before held batches took
     * decisions.
     */
    decisions: z.array(DecisionSchema).optional(),
    /** The decision round, present on that round's bundle alone. */
    round: z.number().int().positive().optional(),
    adjudicated: CensusSchema,
    /**
     * Optional only for a bundle written before settlement verified anything.
     * This build always writes the list. It is empty when adjudication refused
     * or held the batch before verification ran.
     */
    verification: z.array(VerificationTraceSchema).optional(),
    settledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type SettlementBundleV1 = z.infer<typeof SettlementBundleV1Schema>;

/**
 * The artifact id beside the digest, built from the batch and the capsule
 * version. A reader with a ledger record can name the bundle without resolving
 * it. The store keys bytes by digest, not by this id, so a collision here is
 * only a naming coincidence.
 */
export function settlementBundleArtifactId(batchId: string, capsuleVersion: number): ArtifactId {
  return ArtifactIdSchema.parse(
    `run-bundle:${SETTLEMENT_BUNDLE_KIND}:${batchId}:${capsuleVersion}`,
  );
}

/**
 * Encode a document to the bytes that the store hashes. The schema parses the
 * document first, so a document that the schema rejects never reaches custody.
 */
export function encodeSettlementBundle(document: SettlementBundleV1): Uint8Array {
  const validated = SettlementBundleV1Schema.parse(document);
  return Buffer.from(`${canonicalJson(validated)}\n`, 'utf8');
}

/**
 * Decode bytes from the store. Throws on anything the schema does not admit,
 * so a partial document never reports facts that the producer did not write.
 */
export function decodeSettlementBundle(bytes: Uint8Array): SettlementBundleV1 {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return SettlementBundleV1Schema.parse(parsed);
}
