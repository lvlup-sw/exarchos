// The authored contract of the Exarchos workflow capsule.
// A capsule is the compiled form of a workflow: intent, bound knowledge, and authority in one immutable, version-pinned artifact.
// The harness executes it with no governance callbacks. Settlement judges the returned claims against the pinned capsule.
// `authority` and the digest vocabulary derive from the workflow-definition kernel package (see `kernel-derivation.ts`).
//
// `graph` names kernel steps by id and does not restate their structure.
// The kernel enforces graph integrity with a refinement, and a refinement does not survive into JSON Schema.
// So integrity is a separate pass in `capsule-references.ts`.
// Each constraint here is structural: a required key, a `.min(1)`, or a discriminated union.
// The round-trip guard compares this schema with its JSON Schema projection, and Ajv cannot see a refinement.

import { z } from 'zod';
import {
  type WorkflowAuthorityV1,
  WorkflowAuthorityStatementV1Schema,
  WorkflowAuthorityV1Schema,
  WorkflowDefinitionV1Schema,
} from '@lvlup-sw/strategos-contracts';
import { zodToJsonSchema } from '../../utils/json-schema.js';
import {
  EdgeConditionDeclarationSchema,
  EdgeConditionNodeSchema,
  SharedStableIdSchema,
} from '../ir/admission-ir.js';
import { deepStrictify, requireNonEmptyArrayFields, unwrapOptional } from './kernel-derivation.js';

/** The capsule format version. It versions the shape of this file, not one compilation. */
export const CAPSULE_FORMAT_VERSION: '1' = '1';

/**
 * The authority categories that a capsule must carry, each one non-empty.
 * The kernel makes them optional, but settlement judges against authority, so an empty block cannot settle.
 * `goals` is not in the list, because this contract keeps goals under `intent`.
 */
export const CAPSULE_REQUIRED_AUTHORITY_CATEGORIES: readonly string[] = [
  'invariants',
  'assumptions',
  'delegatedDecisions',
  'escalationBoundaries',
];
/**
 * One authority or intent statement: the kernel shape, closed.
 * The annotation gives arrays a typed statement instead of `unknown[]`. `deepStrictify` keeps the source type, so no cast occurs.
 */
const CapsuleStatementSchema: z.ZodType<CapsuleAuthorityStatement> = deepStrictify(
  WorkflowAuthorityStatementV1Schema,
);

/** The content-digest vocabulary of the kernel. */
const KernelDigestSchema = unwrapOptional(WorkflowDefinitionV1Schema.shape.contentHash);
/** One statement, as the kernel types it. */
type CapsuleAuthorityStatement = NonNullable<WorkflowAuthorityV1['invariants']>[number];
/** The authority block of a capsule. The shape derives from the kernel. This contract adds only the required categories. */
export interface ExarchosCapsuleAuthorityV1 {
  readonly invariants: readonly CapsuleAuthorityStatement[];
  readonly assumptions: readonly CapsuleAuthorityStatement[];
  readonly delegatedDecisions: readonly CapsuleAuthorityStatement[];
  readonly escalationBoundaries: readonly CapsuleAuthorityStatement[];
  readonly goals?: readonly CapsuleAuthorityStatement[];
}

/**
 * The authority block schema: the kernel shape, closed, with empty categories refused.
 * The type is asserted, because the derivation builds the schema at runtime.
 * The derivation tests compare its JSON Schema with the kernel JSON Schema to keep the assertion true.
 */
export const ExarchosCapsuleAuthorityV1Schema = requireNonEmptyArrayFields(
  deepStrictify(WorkflowAuthorityV1Schema),
  CAPSULE_REQUIRED_AUTHORITY_CATEGORIES,
) as z.ZodType<ExarchosCapsuleAuthorityV1>;

/** The compile-time assertion helpers for `@proof` types. */
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;

/**
 * The capsule authority narrows the kernel authority and adds no category.
 * `Expect` requires `true`, so the compiler fails when the narrowing stops.
 * @proof
 */
export type _CapsuleAuthorityInventsNoCategory = Expect<
  keyof ExarchosCapsuleAuthorityV1 extends keyof WorkflowAuthorityV1 ? true : false
>;

/**
 * The kernel authority does not satisfy the capsule authority. In the kernel, `{}` is a valid authority.
 * This assertion fails when the required categories become optional.
 * @proof
 */
export type _KernelAuthorityDoesNotSatisfyTheCapsule = Expect<
  IsNotAssignable<WorkflowAuthorityV1, ExarchosCapsuleAuthorityV1>
>;
/** The source of this capsule, and which compilation it is. */
export const CapsuleIdentitySchema = z
  .object({
    workflowId: SharedStableIdSchema,
    /** The digest of the source workflow definition. */
    definitionVersion: KernelDigestSchema,
    designVersion: SharedStableIdSchema,
    /** The compilation number of that design. It increases per workflow. */
    capsuleVersion: z.number().int().min(1),
  })
  .strict();

/** What the workflow is for. Goals live here, not in `authority`. */
export const CapsuleIntentSchema = z
  .object({
    goals: z.array(CapsuleStatementSchema).min(1),
    nonGoals: z.array(CapsuleStatementSchema),
    successCriteria: z.array(CapsuleStatementSchema).min(1),
  })
  .strict();

/** The wait modes of a join. A consumer that needs the bare list reads `.options`. */
export const CapsuleJoinModeSchema = z.enum(['all', 'any', 'quorum']);

/** One unit of work, named by id. */
export const CapsuleTaskSchema = z
  .object({
    taskId: SharedStableIdSchema,
    title: z.string().min(1).max(256),
    /** The kernel step this task compiled from, when it compiled from one. */
    stepId: SharedStableIdSchema.optional(),
  })
  .strict();

export const CapsuleDependencySchema = z
  .object({ from: SharedStableIdSchema, to: SharedStableIdSchema })
  .strict();

export const CapsuleJoinSchema = z
  .object({
    joinId: SharedStableIdSchema,
    waitsFor: z.array(SharedStableIdSchema).min(2),
    mode: CapsuleJoinModeSchema,
  })
  .strict();

/** The test for a finished graph. */
export const CapsuleCompletionPredicateSchema = z
  .object({
    /** The closed condition AST. It holds no expression, command, or closure. */
    condition: EdgeConditionNodeSchema,
    /** The facts and events that the condition can name, so a consumer can compile it. */
    declares: EdgeConditionDeclarationSchema,
  })
  .strict();

/**
 * The semantic task graph. Acyclicity and id resolution are not structural, so this schema does not express them.
 * `capsule-references.ts` checks both over a structurally valid document.
 */
export const CapsuleGraphSchema = z
  .object({
    tasks: z.array(CapsuleTaskSchema).min(1),
    dependencies: z.array(CapsuleDependencySchema),
    joins: z.array(CapsuleJoinSchema),
    completionPredicate: CapsuleCompletionPredicateSchema,
  })
  .strict();

/** The kinds of a task input or result field. */
export const CapsuleFieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'array',
  'object',
]);

/** One field of a task input or result. It is flat, so a nested payload must name a schema. */
export const CapsuleFieldDescriptorSchema = z
  .object({
    name: SharedStableIdSchema,
    type: CapsuleFieldTypeSchema,
    required: z.boolean(),
  })
  .strict();

/** What a worker can propose when the capsule assumptions are wrong. */
export const CapsuleDeviationEnvelopeSchema = z
  .object({
    allowedDeviationKinds: z.array(SharedStableIdSchema).min(1),
    requiresApproval: z.boolean(),
  })
  .strict();

/** The typed shapes that settlement judges a returned claim against. */
export const CapsuleContractsSchema = z
  .object({
    taskInputs: z.record(SharedStableIdSchema, z.array(CapsuleFieldDescriptorSchema)),
    taskResults: z.record(SharedStableIdSchema, z.array(CapsuleFieldDescriptorSchema)),
    evidenceKinds: z.array(SharedStableIdSchema).min(1),
    deviationEnvelope: CapsuleDeviationEnvelopeSchema,
  })
  .strict();

/**
 * The bound design knowledge. `eager` is closed and refuses supplement keys. `hybrid` requires a budget.
 * It is a discriminated union, because a refinement does not survive into JSON Schema.
 */
export const CapsuleKnowledgeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('eager'),
      rationale: z.array(CapsuleStatementSchema),
      patterns: z.array(CapsuleStatementSchema),
      glossary: z.array(CapsuleStatementSchema),
    })
    .strict(),
  z
    .object({
      mode: z.literal('hybrid'),
      rationale: z.array(CapsuleStatementSchema),
      patterns: z.array(CapsuleStatementSchema),
      glossary: z.array(CapsuleStatementSchema),
      unresolvedRefs: z.array(SharedStableIdSchema),
      /** The byte budget that a runtime can spend to fetch unbound knowledge. */
      supplementBudget: z.number().int().min(1),
    })
    .strict(),
]);

/** Runtime capability constraints. The one optional section. */
export const CapsuleExecutionProfileSchema = z
  .object({
    capabilities: z.array(SharedStableIdSchema).min(1),
    preferredAgentKinds: z.array(SharedStableIdSchema).optional(),
  })
  .strict();

/** One record this capsule compiled from, named by id and pinned by digest. */
export const CapsuleSourceSchema = z
  .object({ sourceId: SharedStableIdSchema, digest: KernelDigestSchema })
  .strict();

/** The compilation audit trail. */
export const CapsuleProvenanceSchema = z
  .object({
    sources: z.array(CapsuleSourceSchema).min(1),
    compiledAt: z.iso.datetime({ offset: true }),
    compilerVersion: SharedStableIdSchema,
  })
  .strict();

/** The risk tiers that route task verification. */
export const CapsuleRiskTierSchema = z.enum(['low', 'medium', 'high']);

/**
 * A git ref that a task diff is measured against, in a safe subset of git ref names. It starts with a
 * letter, a digit or an underscore, so git never reads it as an option. It holds no whitespace and no
 * `..`, so it never names a range. It is a pattern, not a refinement, so the JSON Schema projection
 * carries the same rule.
 */
export const CapsuleBaseRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._/+@-]*$/,
    'a base ref starts with a letter, digit or underscore, contains no "..", and uses only letters, digits and . _ / + @ -',
  );

/**
 * The verification terms of one task, fixed when the capsule is compiled.
 * The tier and the boundary flag select the gates of the task, and the base names the start of its diff.
 * A task that names its own tier or base at claim time chooses what judges it.
 * Thus settlement reads the terms from the pinned capsule.
 */
export const CapsuleTaskVerificationSchema = z
  .object({
    riskTier: CapsuleRiskTierSchema,
    boundaryTouching: z.boolean(),
    baseRef: CapsuleBaseRefSchema,
  })
  .strict();

/**
 * The settlement terms for each batch of this capsule. The batch id is not here.
 * Settlement is idempotent on `(capsuleVersion, batchId)`, and a rejected batch resubmits as a new batch under the same terms.
 * A compiled `batchId` makes that resubmission the same key with a different request, which the claim refuses.
 */
export const CapsuleSettlementContractSchema = z
  .object({
    requiredResults: z.array(SharedStableIdSchema).min(1),
    /**
     * Per-task verification terms, keyed by task id. The field is optional, because the contract derives for any kernel step.
     * A settlement that needs the terms of a task refuses a task without terms.
     */
    taskVerification: z.record(SharedStableIdSchema, CapsuleTaskVerificationSchema).optional(),
  })
  .strict();

/** The whole compiled artifact. */
export const ExarchosCapsuleV1Schema = z
  .object({
    capsuleSchemaVersion: z.literal(CAPSULE_FORMAT_VERSION),
    identity: CapsuleIdentitySchema,
    intent: CapsuleIntentSchema,
    authority: ExarchosCapsuleAuthorityV1Schema,
    graph: CapsuleGraphSchema,
    contracts: CapsuleContractsSchema,
    knowledge: CapsuleKnowledgeSchema,
    executionProfile: CapsuleExecutionProfileSchema.optional(),
    provenance: CapsuleProvenanceSchema,
    settlementContract: CapsuleSettlementContractSchema,
  })
  .strict();

export type ExarchosCapsuleV1 = z.infer<typeof ExarchosCapsuleV1Schema>;

/** The JSON Schema projection of this contract, as the chokepoint types it. */
export type ExarchosCapsuleJsonSchema = ReturnType<
  typeof zodToJsonSchema<typeof ExarchosCapsuleV1Schema>
>;

/** The generated draft-2020-12 JSON Schema for a capsule. The same source gives identical bytes. */
export function exarchosCapsuleJsonSchema(): ExarchosCapsuleJsonSchema {
  return zodToJsonSchema(ExarchosCapsuleV1Schema);
}
