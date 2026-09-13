// ─── The Exarchos workflow capsule — authored contract ───────────────────────
//
// A capsule is what a workflow becomes once intent, bound knowledge and
// authority are compiled into one immutable, version-pinned artifact. The
// harness executes it without calling back for governance, and settlement
// adjudicates the returned claims against the capsule that was pinned when the
// work was compiled — not against whatever the design says now.
//
// The workflow-definition kernel is a published, versioned contract, and this
// schema borrows from it rather than restating it. `authority` and the digest
// vocabulary are DERIVED from the package (see `kernel-derivation.ts`); a
// re-typed copy of either would drift silently, which the charter calls a
// defect.
//
// `graph` names kernel steps by id and does not restate their structure. That
// is not only a size argument. The kernel enforces its own graph integrity
// through a refinement, and a refinement does not survive into JSON Schema:
// embedding the kernel definition here would produce a contract whose Ajv
// projection accepts documents its Zod source rejects. Measured on 0.14.0
// against a transition naming a step that does not exist — Zod refuses it, the
// emitted JSON Schema does not. So structure stays referential, and integrity
// is a separate pass (`capsule-references.ts`), which is how the admission
// contract in this tree already splits the same problem.
//
// Every constraint here is therefore STRUCTURAL — a required key, a `.min(1)`,
// a discriminated union. Nothing is expressed as a refinement, because the
// round-trip guard compares this schema against its own JSON Schema projection
// and a rule Ajv cannot see reads as a contradiction rather than as the missing
// projection it is.
// ────────────────────────────────────────────────────────────────────────────

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

/** The capsule FORMAT version — this file's shape, not a compilation's number. */
export const CAPSULE_FORMAT_VERSION: '1' = '1';

/**
 * The authority categories a capsule must carry, and carry non-empty.
 *
 * The kernel leaves all five optional because it serializes the frame and
 * proves none of it. A capsule is adjudicated against its authority, so an
 * empty block is not a permissive capsule — it is one that cannot be settled
 * against anything. `goals` is deliberately absent for a reason of its own: the
 * kernel keeps goals here, this contract keeps a capsule's goals under `intent`,
 * and requiring a category this contract does not use would be inventing an
 * obligation rather than tightening one.
 */
export const CAPSULE_REQUIRED_AUTHORITY_CATEGORIES: readonly string[] = [
  'invariants',
  'assumptions',
  'delegatedDecisions',
  'escalationBoundaries',
];
/**
 * One authority or intent statement, closed — the kernel's shape, our strictness.
 *
 * Annotated with the kernel's statement type, not left to inference, so every
 * array built from it carries typed statements rather than `unknown[]`. No cast
 * is involved: `deepStrictify` preserves its source's output type.
 */
const CapsuleStatementSchema: z.ZodType<CapsuleAuthorityStatement> = deepStrictify(
  WorkflowAuthorityStatementV1Schema,
);

/** The kernel's content-digest vocabulary, borrowed rather than re-typed. */
const KernelDigestSchema = unwrapOptional(WorkflowDefinitionV1Schema.shape.contentHash);
/** One statement, as the kernel types it. Borrowed, so a kernel change lands here. */
type CapsuleAuthorityStatement = NonNullable<WorkflowAuthorityV1['invariants']>[number];
/**
 * The authority block a capsule carries.
 *
 * The SHAPE is derived; this declares only which categories are required, which
 * is the one thing this contract adds. The statement type itself is the
 * kernel's, so a kernel change to it arrives here rather than being mirrored.
 */
export interface ExarchosCapsuleAuthorityV1 {
  readonly invariants: readonly CapsuleAuthorityStatement[];
  readonly assumptions: readonly CapsuleAuthorityStatement[];
  readonly delegatedDecisions: readonly CapsuleAuthorityStatement[];
  readonly escalationBoundaries: readonly CapsuleAuthorityStatement[];
  readonly goals?: readonly CapsuleAuthorityStatement[];
}

/**
 * The authority block: the kernel's shape, closed, with the empty case refused.
 *
 * The annotation is asserted rather than inferred, because the derivation
 * builds the schema at runtime and cannot carry a static shape out with it.
 * What keeps the assertion honest is not the compiler: the derivation tests
 * compare this schema's emitted JSON Schema against the kernel's own, and the
 * fixture corpus exercises every category through both validators.
 */
export const ExarchosCapsuleAuthorityV1Schema = requireNonEmptyArrayFields(
  deepStrictify(WorkflowAuthorityV1Schema),
  CAPSULE_REQUIRED_AUTHORITY_CATEGORIES,
) as z.ZodType<ExarchosCapsuleAuthorityV1>;

/** The compile-time assertion helpers, per this repository's `@proof` idiom. */
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;

/**
 * The capsule's authority is a NARROWING of the kernel's, never a widening.
 *
 * Wrapped in `Expect<…>` rather than left as a bare conditional. A bare
 * `A extends B ? true : never` alias resolves to `never` when the relation
 * fails and compiles perfectly well — it records the question without ever
 * demanding an answer. `Expect` constrains its parameter to `true`, so the day
 * this narrowing stops holding the compiler says so.
 * @proof
 */
export type _CapsuleAuthorityInventsNoCategory = Expect<
  keyof ExarchosCapsuleAuthorityV1 extends keyof WorkflowAuthorityV1 ? true : false
>;

/**
 * And the narrowing has TEETH: the kernel's own authority does not satisfy this
 * contract. The kernel leaves every category optional, so `{}` is a valid
 * `WorkflowAuthorityV1`; if that were also a valid capsule authority, the four
 * required categories would be decoration. This is the assertion that fails the
 * day someone relaxes them.
 * @proof
 */
export type _KernelAuthorityDoesNotSatisfyTheCapsule = Expect<
  IsNotAssignable<WorkflowAuthorityV1, ExarchosCapsuleAuthorityV1>
>;
/** What this capsule is a compilation OF, and which compilation it is. */
export const CapsuleIdentitySchema = z
  .object({
    workflowId: SharedStableIdSchema,
    /** The digest of the workflow definition this capsule compiled from. */
    definitionVersion: KernelDigestSchema,
    designVersion: SharedStableIdSchema,
    /** Which compilation of that design this is. Monotonic per workflow. */
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

/**
 * How the work fans out and rejoins: the modes a join may wait under.
 *
 * The vocabulary is the schema, and a consumer that wants the bare list reads
 * `.options` off it. Pinning the list separately and deriving the schema back
 * from it says the same thing twice and leaves two places to change.
 */
export const CapsuleJoinModeSchema = z.enum(['all', 'any', 'quorum']);

/** One unit of work, named by id and pointing at the kernel step it compiled from. */
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

/**
 * The semantic task graph and the test for having finished it.
 *
 * Acyclicity and the resolvability of every id named here are NOT expressed:
 * neither is structural, so neither survives into JSON Schema. Both are
 * resolved by `capsule-references.ts`, which runs over an already
 * structurally-valid document.
 */
export const CapsuleCompletionPredicateSchema = z
  .object({
    /** The closed condition AST — no expression, no command, no closure. */
    condition: EdgeConditionNodeSchema,
    /** The facts and events the condition may name, so a consumer can compile it. */
    declares: EdgeConditionDeclarationSchema,
  })
  .strict();

export const CapsuleGraphSchema = z
  .object({
    tasks: z.array(CapsuleTaskSchema).min(1),
    dependencies: z.array(CapsuleDependencySchema),
    joins: z.array(CapsuleJoinSchema),
    completionPredicate: CapsuleCompletionPredicateSchema,
  })
  .strict();

/** The scalar kinds a task input or result field may carry. */
export const CapsuleFieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'array',
  'object',
]);

/**
 * One field of a task's input or result.
 *
 * Deliberately flat. A recursive descriptor would be a second, worse JSON
 * Schema living inside this one, and a capsule that needs nested payload shapes
 * should name a schema rather than inline it.
 */
export const CapsuleFieldDescriptorSchema = z
  .object({
    name: SharedStableIdSchema,
    type: CapsuleFieldTypeSchema,
    required: z.boolean(),
  })
  .strict();

/** What a worker may propose when it finds the capsule's assumptions wrong. */
export const CapsuleDeviationEnvelopeSchema = z
  .object({
    allowedDeviationKinds: z.array(SharedStableIdSchema).min(1),
    requiresApproval: z.boolean(),
  })
  .strict();

/** The typed shapes settlement adjudicates a returned claim against. */
export const CapsuleContractsSchema = z
  .object({
    taskInputs: z.record(SharedStableIdSchema, z.array(CapsuleFieldDescriptorSchema)),
    taskResults: z.record(SharedStableIdSchema, z.array(CapsuleFieldDescriptorSchema)),
    evidenceKinds: z.array(SharedStableIdSchema).min(1),
    deviationEnvelope: CapsuleDeviationEnvelopeSchema,
  })
  .strict();

/**
 * The bound design knowledge, as a discriminated union rather than an object
 * with a mode field.
 *
 * `eager` declares no supplement keys at all, so closing the object is what
 * refuses them; `hybrid` requires a budget. Expressed as a union because that
 * is the only form in which the distinction survives into JSON Schema — as an
 * enum plus a refinement it would vanish at the Ajv boundary.
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
      /** The byte budget a runtime may spend fetching what was not bound. */
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

/**
 * The terms one batch is settled under.
 *
 * Carried INSIDE the capsule so a compiled artifact is complete on its own.
 * Note the tension to resolve upstream: settlement is idempotent on the pair
 * `(capsuleVersion, batchId)`, and a pair implies one capsule may be settled
 * over more than one batch — which would make `batchId` capsule-external.
 */
export const CapsuleSettlementContractSchema = z
  .object({
    requiredResults: z.array(SharedStableIdSchema).min(1),
    batchId: SharedStableIdSchema,
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

/** The JSON Schema projection of this contract, exactly as the chokepoint types it. */
export type ExarchosCapsuleJsonSchema = ReturnType<
  typeof zodToJsonSchema<typeof ExarchosCapsuleV1Schema>
>;

/**
 * The generated JSON Schema for a capsule, through the draft-2020-12
 * chokepoint. Deterministic: the same source yields identical bytes anywhere.
 */
export function exarchosCapsuleJsonSchema(): ExarchosCapsuleJsonSchema {
  return zodToJsonSchema(ExarchosCapsuleV1Schema);
}
