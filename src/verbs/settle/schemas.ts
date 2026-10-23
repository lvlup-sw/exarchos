/**
 * The Zod output schema for `settle`. It mirrors the `SettlementReceipt` shape in `types.ts`.
 * The MCP adapter parses the real handler output against this schema and replaces a miss with `INTERNAL_ERROR`.
 * Each object is `.passthrough()`, so a field that a later build adds does not break a response or a replayed receipt.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { SETTLEMENT_OUTCOME_RULES, SETTLEMENT_OUTCOMES, type SettlementOutcome } from './adjudicate.js';
import type { SettlementReceipt, SettlementVerificationTrace } from './types.js';

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

/**
 * The receipt copy of one verification trace. It does not name `qualifiers`, because the `describe` response of
 * `settle` has no room for it under the shared budget. The object is `.passthrough()`, so a trace with qualifiers
 * still parses. The settlement bundle has its own strict trace schema, and this schema does not change it.
 */
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

/** The call after one outcome, from the rule of the outcome, as the start of a sentence. */
function nextCallSentence(outcome: SettlementOutcome): string {
  const { next } = SETTLEMENT_OUTCOME_RULES[outcome];
  return `${next.charAt(0).toUpperCase()}${next.slice(1)}`;
}

/**
 * The outcomes that verify nothing at their read, each with the call that follows it.
 * The rule of each outcome gives both facts, so the text follows the record.
 */
const UNVERIFIED_ENTRIES = SETTLEMENT_OUTCOMES.filter((outcome) => !SETTLEMENT_OUTCOME_RULES[outcome].verifies)
  .map((outcome) => `\`${outcome}\`: ${SETTLEMENT_OUTCOME_RULES[outcome].next}. `)
  .join('');

/**
 * The call that follows each outcome. An agent reads this text through `describe`.
 * `describe` returns the output schema twice, so each character here counts twice against the
 * response budget of `describe` (`DESCRIBE_ECONOMY_BUDGET_TOKENS`). The text is short for that
 * reason: the name of an outcome gives its meaning. Each call comes from the outcome rules.
 *
 * The text also says what `acceptedTasks` lists under an outcome that verifies nothing. Such a batch
 * verifies nothing at its read. The tasks that settlement verified before a read changed stay
 * complete, and a receipt of an earlier build can carry `rejected` after a verification. Thus the
 * text says "at their read".
 * The `designRevision` rule is stated once, for all outcomes.
 */
const OUTCOME_GUIDE =
  '`settled`: each required task is complete. ' +
  '`accepted-with-rationale`: `settled`, and a claim records a delegated choice. ' +
  `\`corrective-capsule\`: the tasks that passed are complete. ${nextCallSentence('corrective-capsule')}. ` +
  'At their read the next three verify nothing, and `acceptedTasks` lists claims with no finding. ' +
  UNVERIFIED_ENTRIES +
  'Any outcome with a `designRevision`: as `recompile-required`';

const SettlementReceiptData = z
  .object({
    operationId: z.string().min(1),
    streamId: z.string().min(1),
    capsule: ReceiptCapsuleSchema,
    outcome: z.enum(SETTLEMENT_OUTCOMES).describe(OUTCOME_GUIDE),
    acceptedTasks: z.array(z.string().min(1)),
    unresolved: z.array(ReceiptUnresolvedTaskSchema).optional(),
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

/** A compile error unless `T` is exactly `true`. */
type Expect<T extends true> = T;

/**
 * The type with each index signature removed at each depth, and each array read-only. A
 * `.passthrough()` object infers an index signature, and the receipt interface has none.
 */
type Closed<T> = T extends readonly (infer Item)[]
  ? readonly Closed<Item>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : number extends K ? never : K]: Closed<T[K]> }
    : T;

/** The receipt that the output schema admits, with no index signature. */
type ReceiptOfOutputSchema = Closed<z.output<typeof SettlementReceiptData>>;

/** One verification trace that the output schema admits, with no index signature. */
type TraceOfOutputSchema = Closed<z.output<typeof ReceiptVerificationSchema>>;

/** The trace fields that the output schema does not name. */
type TraceFieldsTheSchemaDoesNotName = Exclude<keyof SettlementVerificationTrace, keyof TraceOfOutputSchema>;

/**
 * Each receipt that this build writes is a value of the output schema. Each field type and each
 * enum member of the receipt type is one that the schema admits.
 * @proof
 */
export type _SettlementReceiptIsAValueOfItsOutputSchema = Expect<
  SettlementReceipt extends ReceiptOfOutputSchema ? true : false
>;

/**
 * The receipt type and the output schema name the same fields.
 * @proof
 */
export type _SettlementReceiptAndItsOutputSchemaNameTheSameFields = Expect<
  [Exclude<keyof ReceiptOfOutputSchema, keyof SettlementReceipt>, Exclude<keyof SettlementReceipt, keyof ReceiptOfOutputSchema>] extends [never, never]
    ? true
    : false
>;

/**
 * The trace type and the trace item of the output schema name the same fields, except `qualifiers`. The schema
 * names no field that the type does not have. A new trace field that the schema does not name fails this proof.
 * When the schema names `qualifiers`, this proof fails too, so the exception goes with it.
 * @proof
 */
export type _SettlementTraceAndItsOutputSchemaNameTheSameFields = Expect<
  [Exclude<keyof TraceOfOutputSchema, keyof SettlementVerificationTrace>] extends [never]
    ? [TraceFieldsTheSchemaDoesNotName] extends ['qualifiers']
      ? ['qualifiers'] extends [TraceFieldsTheSchemaDoesNotName]
        ? true
        : false
      : false
    : false
>;
