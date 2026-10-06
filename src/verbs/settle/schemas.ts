/**
 * The Zod output schema for `settle`. It mirrors the `SettlementReceipt` shape in `types.ts`.
 * The MCP adapter parses the real handler output against this schema and replaces a miss with `INTERNAL_ERROR`.
 * Each object is `.passthrough()`, so a field that a later build adds does not break a response or a replayed receipt.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

const ReceiptBundleRefSchema = z
  .object({
    artifactId: z.string().min(1),
    digest: z.object({ algorithm: z.string().min(1), value: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const ReceiptFindingSchema = z
  .object({
    kind: z.string().min(1),
    subject: z.string().min(1),
    at: z.string().min(1),
    message: z.string().min(1),
  })
  .passthrough();

const ReceiptCapsuleSchema = z
  .object({
    workflowId: z.string().min(1),
    definitionVersion: z.string().min(1),
    designVersion: z.string().min(1),
    capsuleVersion: z.number().int().min(1),
    batchId: z.string().min(1),
  })
  .passthrough();

const ReceiptCensusSchema = z
  .object({
    claims: z.number().int().nonnegative(),
    requiredResults: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    deviations: z.number().int().nonnegative(),
    /**
     * Optional, like `bundleRefs`. A receipt replayed from a claim written before settlement
     * verified tasks carries no count.
     */
    verification: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const ReceiptVerificationSchema = z
  .object({
    taskId: z.string().min(1),
    outcome: z.enum(['verified', 'already-complete', 'failed']),
    operationId: z.string().min(1).optional(),
    failedLeaf: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    bundleRefs: z.array(ReceiptBundleRefSchema).min(1).optional(),
  })
  .passthrough();

const SettlementReceiptData = z
  .object({
    operationId: z.string().min(1),
    streamId: z.string().min(1),
    capsule: ReceiptCapsuleSchema,
    outcome: z.enum(['settled', 'rejected', 'deviation-pending']),
    acceptedTasks: z.array(z.string().min(1)),
    findings: z.array(ReceiptFindingSchema),
    adjudicated: ReceiptCensusSchema,
    requestDigest: z.string().min(1),
    tailSequence: z.number().int().nonnegative(),
    verification: z.array(ReceiptVerificationSchema).optional(),
    bundleRefs: z.array(ReceiptBundleRefSchema).min(1).optional(),
    round: z.number().int().nonnegative().optional(),
    pendingDeviations: z
      .array(
        z
          .object({
            deviationId: z.string().min(1),
            deviationKind: z.string().min(1),
            statement: z.string().min(1),
            affectedTasks: z.array(z.string().min(1)).optional(),
          })
          .passthrough(),
      )
      .optional(),
    decisions: z
      .array(
        z
          .object({
            deviationId: z.string().min(1),
            decision: z.enum(['accepted', 'rejected']),
            actor: z.string().min(1),
            rationale: z.string().min(1),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const SettlementOutputSchema = EnvelopeSchema(SettlementReceiptData);
