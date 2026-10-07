/**
 * The Zod output schema for `settle`. It mirrors the `SettlementReceipt` shape in `types.ts`.
 * The MCP adapter parses the real handler output against this schema and replaces a miss with `INTERNAL_ERROR`.
 * Each object is `.passthrough()`, so a field that a later build adds does not break a response or a replayed receipt.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { SETTLEMENT_OUTCOMES } from './adjudicate.js';

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

/**
 * One task that a `corrective-capsule` batch leaves unresolved. `cause` is the kind of the finding
 * against the task. The two optional fields name the verification segment of the task that halted.
 */
const ReceiptUnresolvedTaskSchema = z
  .object({
    taskId: z.string().min(1),
    cause: z.string().min(1),
    failedLeaf: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * The meaning of each outcome and the call that follows it. An agent reads this text through `describe`.
 * The description of the action has a token budget, and this text has none.
 */
const OUTCOME_GUIDE =
  'How the batch stands, and the call that follows. No outcome compiles a capsule: only prepare ' +
  'compiles. `settled`: each required task is complete, and no settle call follows. ' +
  '`rejected`: the request or a deviation is in error, and nothing was verified. Settle the ' +
  'corrected request under a new batchId on the same capsule. `deviation-pending`: a ' +
  'deviation waits for its decision, and nothing was verified. Settle the same batchId with ' +
  '`decisions` and no claims. `corrective-capsule`: the tasks that passed are complete, and ' +
  '`unresolved` names the others. Correct them, then settle a new batchId on the same capsule ' +
  'that claims only those tasks. When the receipt carries `designRevision`, prepare first and ' +
  'settle under the capsule that prepare returns. `recompile-required`: a design revision ' +
  'after the capsule names a claimed task or an unfinished required task, and nothing was ' +
  'verified. Prepare again, then settle under the capsule that prepare returns. ' +
  '`accepted-with-rationale`: no batch gets this outcome in this build. The design names ' +
  '`settled` as accepted and `deviation-pending` as decision-required. A replay can return a ' +
  '`rejected` receipt of an earlier build, which can also record a superseded claim or a ' +
  'failed verification';

const SettlementReceiptData = z
  .object({
    operationId: z.string().min(1),
    streamId: z.string().min(1),
    capsule: ReceiptCapsuleSchema,
    outcome: z.enum(SETTLEMENT_OUTCOMES).describe(OUTCOME_GUIDE),
    acceptedTasks: z
      .array(z.string().min(1))
      .describe(
        'Under `settled`, `accepted-with-rationale` and `corrective-capsule`: the claimed tasks ' +
          'that are recorded complete. Under each other outcome this build verifies nothing, ' +
          'and the list holds the tasks whose claims the shape pass found no fault in',
      ),
    unresolved: z
      .array(ReceiptUnresolvedTaskSchema)
      .optional()
      .describe(
        'Present only under `corrective-capsule`: the tasks that the correction claims, sorted ' +
          'by task id. `cause` is the kind of the finding against the task. `failedLeaf` and ' +
          '`operationId` name its halted verification segment',
      ),
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
    designRevision: z
      .object({
        priorDesignVersion: z.number().int().min(1),
        nextDesignVersion: z.number().int().min(2),
        deviationIds: z.array(z.string().min(1)).min(1),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const SettlementOutputSchema = EnvelopeSchema(SettlementReceiptData);
