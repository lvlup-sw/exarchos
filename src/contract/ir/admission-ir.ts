/**
 * The shared admission IR: the cross-product wire model for admission policies, the closed
 * edge-condition nodes, evidence requirements, waivers, approvals and action references.
 * These Zod schemas are the one authored source and the Exarchos runtime validators.
 * `admission-ir-schema.ts` derives the checked-in JSON Schema from them.
 *
 * Every object is `.strict()`, and every leaf is a scalar, a closed enum, a stable id or a closed
 * edge-condition node. No field holds an open value, so a document cannot carry a shell command,
 * a closure or an implementation binding. The IR carries references as stable ids.
 * `references.ts` resolves them and rejects a dangling reference.
 */

import { z } from 'zod';
import { zodToJsonSchema } from '../../utils/json-schema.js';

/** The shared admission IR wire-contract version. */
export const SHARED_ADMISSION_IR_VERSION = '1' as const;

/**
 * A provider-neutral stable id, with the same character class as the runtime `StableIdValueSchema`.
 * A shell fragment, a path or an expression fails the pattern. `roundtrip.test.ts` compares the two.
 */
export const SharedStableIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'stable ids may contain only letters, digits, dot, underscore, colon, and hyphen',
  );
export type SharedStableId = z.infer<typeof SharedStableIdSchema>;

/** A reference to a policy DEFINED in the same document (`policies[].policyId`). */
export const PolicyRefSchema = SharedStableIdSchema;
/** A reference to a requirement DEFINED in the same document. */
export const RequirementRefSchema = SharedStableIdSchema;
/**
 * A reference to an Exarchos action by its `<tool>.<action>` ActionId. It is a stable id.
 * `references.ts` resolves it against the real ActionId set.
 */
export const ActionRefSchema = SharedStableIdSchema;

/**
 * The closed evidence-subject kinds that an evidence requirement can target.
 * They mirror the runtime `EvidenceSubjectV1` discriminants, and `roundtrip.test.ts` compares them.
 */
export const IR_SUBJECT_KINDS = [
  'workflow',
  'phase-attempt',
  'wave',
  'task',
  'commit',
  'diff',
  'artifact',
] as const;
export type IrSubjectKind = (typeof IR_SUBJECT_KINDS)[number];
const SubjectKindSchema = z.enum(IR_SUBJECT_KINDS);

/**
 * The closed edge-condition node kinds. They mirror the runtime `EDGE_CONDITION_NODE_KINDS`,
 * and `roundtrip.test.ts` fails when the two differ.
 */
export const IR_EDGE_CONDITION_KINDS = [
  'eventObserved',
  'factPresent',
  'factEquals',
  'counterCompare',
  'all',
  'any',
  'not',
] as const;
export type IrEdgeConditionKind = (typeof IR_EDGE_CONDITION_KINDS)[number];

/** Comparison operators for `counterCompare` (mirror of runtime `EDGE_COMPARE_OPS`). */
export const IR_EDGE_COMPARE_OPS = ['lt', 'lte', 'eq', 'gte', 'gt'] as const;
export type IrEdgeCompareOp = (typeof IR_EDGE_COMPARE_OPS)[number];

/** Declared fact-field scalar types (mirror of runtime `FactType`). */
export const IR_FACT_TYPES = ['string', 'number', 'boolean'] as const;

/** The closed scalar leaf: a string, a number or a boolean. */
const FactScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const NonEmptyStringSchema = z.string().min(1);

/**
 * The static shape of the closed edge-condition AST. It is explicit because `z.lazy` cannot infer a
 * recursive type. It must match {@link EdgeConditionNodeSchema}.
 */
export type IrEdgeConditionNode =
  | { readonly kind: 'eventObserved'; readonly event: string }
  | { readonly kind: 'factPresent'; readonly field: string }
  | {
      readonly kind: 'factEquals';
      readonly field: string;
      readonly value: string | number | boolean;
    }
  | {
      readonly kind: 'counterCompare';
      readonly field: string;
      readonly op: IrEdgeCompareOp;
      readonly value: number;
    }
  | { readonly kind: 'all'; readonly operands: readonly IrEdgeConditionNode[] }
  | { readonly kind: 'any'; readonly operands: readonly IrEdgeConditionNode[] }
  | { readonly kind: 'not'; readonly operand: IrEdgeConditionNode };

/**
 * The closed edge-condition AST as a Zod schema. Each arm is `.strict()`, so the schema rejects an
 * unknown property such as `command`. A node with an unknown `kind` fails the union.
 */
export const EdgeConditionNodeSchema: z.ZodType<IrEdgeConditionNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('eventObserved'), event: NonEmptyStringSchema }).strict(),
    z.object({ kind: z.literal('factPresent'), field: NonEmptyStringSchema }).strict(),
    z
      .object({ kind: z.literal('factEquals'), field: NonEmptyStringSchema, value: FactScalarSchema })
      .strict(),
    z
      .object({
        kind: z.literal('counterCompare'),
        field: NonEmptyStringSchema,
        op: z.enum(IR_EDGE_COMPARE_OPS),
        value: z.number(),
      })
      .strict(),
    z.object({ kind: z.literal('all'), operands: z.array(EdgeConditionNodeSchema) }).strict(),
    z.object({ kind: z.literal('any'), operands: z.array(EdgeConditionNodeSchema) }).strict(),
    z.object({ kind: z.literal('not'), operand: EdgeConditionNodeSchema }).strict(),
  ]),
);

/**
 * The declaration that goes with a condition, so the consumer can compile it with `compileEdgeCondition`.
 * `fields` maps each fact name to its scalar type. `events` lists the observable event names.
 */
export const EdgeConditionDeclarationSchema = z
  .object({
    fields: z.record(NonEmptyStringSchema, z.enum(IR_FACT_TYPES)),
    events: z.array(NonEmptyStringSchema),
  })
  .strict();
export type EdgeConditionDeclaration = z.infer<typeof EdgeConditionDeclarationSchema>;

/**
 * An admission-policy definition. `requires` holds requirement ids from the same document.
 * `onDeny` holds the ActionIds that can remediate a denial.
 */
export const PolicyDefinitionSchema = z
  .object({
    policyId: SharedStableIdSchema,
    requires: z.array(RequirementRefSchema),
    onDeny: z.array(ActionRefSchema),
  })
  .strict();
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;

const GateEvidenceRequirementSchema = z
  .object({
    requirementId: SharedStableIdSchema,
    kind: z.literal('gate-evidence'),
    gateId: SharedStableIdSchema,
    subjectKind: SubjectKindSchema,
  })
  .strict();

const ApprovalRequirementSchema = z
  .object({
    requirementId: SharedStableIdSchema,
    kind: z.literal('approval'),
    approvalClass: SharedStableIdSchema,
    minimumApprovals: z.number().int().positive(),
    subjectKind: SubjectKindSchema,
  })
  .strict();

const CorroborationRequirementSchema = z
  .object({
    requirementId: SharedStableIdSchema,
    kind: z.literal('corroboration'),
    sourceRequirementId: RequirementRefSchema,
    minimumIndependentSources: z.number().int().min(2),
    subjectKind: SubjectKindSchema,
  })
  .strict();

/**
 * The closed evidence-requirement kinds. They mirror the runtime `AdmissionRequirementV1`
 * discriminants, and `roundtrip.test.ts` compares the two sets.
 */
export const IR_REQUIREMENT_KINDS = ['gate-evidence', 'approval', 'corroboration'] as const;
export type IrRequirementKind = (typeof IR_REQUIREMENT_KINDS)[number];

/**
 * The closed evidence-requirement model. `corroboration.sourceRequirementId` is a requirement
 * reference, so it can dangle.
 */
export const RequirementDefinitionSchema = z.discriminatedUnion('kind', [
  GateEvidenceRequirementSchema,
  ApprovalRequirementSchema,
  CorroborationRequirementSchema,
]);
export type RequirementDefinition = z.infer<typeof RequirementDefinitionSchema>;

/** A reference to the Exarchos action that effects a transition. */
const EdgeEffectSchema = z.object({ actionRef: ActionRefSchema }).strict();

/**
 * A workflow edge: a closed condition with its declaration, the policy reference that gates it
 * (`admits`), and the action reference that effects it (`effect.actionRef`).
 */
export const EdgeDefinitionSchema = z
  .object({
    edgeId: SharedStableIdSchema,
    from: SharedStableIdSchema,
    to: SharedStableIdSchema,
    declaration: EdgeConditionDeclarationSchema,
    condition: EdgeConditionNodeSchema,
    admits: PolicyRefSchema,
    effect: EdgeEffectSchema,
  })
  .strict();
export type EdgeDefinition = z.infer<typeof EdgeDefinitionSchema>;

const WorkflowWaiverScopeSchema = z
  .object({ kind: z.literal('workflow'), workflowId: SharedStableIdSchema })
  .strict();
const PhaseAttemptWaiverScopeSchema = z
  .object({ kind: z.literal('phase-attempt'), phaseAttemptId: SharedStableIdSchema })
  .strict();
const SubjectWaiverScopeSchema = z
  .object({ kind: z.literal('subject'), subjectKind: SubjectKindSchema })
  .strict();

/** The closed waiver scope (mirror of the runtime `WaiverScopeV1` discriminants). */
export const IR_WAIVER_SCOPE_KINDS = ['workflow', 'phase-attempt', 'subject'] as const;
export type IrWaiverScopeKind = (typeof IR_WAIVER_SCOPE_KINDS)[number];

/** The closed waiver scope (mirror of the runtime `WaiverScopeV1` discriminants). */
export const WaiverScopeSchema = z.discriminatedUnion('kind', [
  WorkflowWaiverScopeSchema,
  PhaseAttemptWaiverScopeSchema,
  SubjectWaiverScopeSchema,
]);
export type WaiverScope = z.infer<typeof WaiverScopeSchema>;

/** The approval authorization wire model attached to a waiver. */
const ApprovalAuthorizationSchema = z
  .object({
    approvalClass: SharedStableIdSchema,
    minimumApprovals: z.number().int().positive(),
  })
  .strict();

/**
 * A waiver definition: its scope, the requirement references it waives, an ISO expiry, and the
 * approval that a waiver needs. A `waives` reference can dangle.
 */
export const WaiverDefinitionSchema = z
  .object({
    waiverId: SharedStableIdSchema,
    scope: WaiverScopeSchema,
    waives: z.array(RequirementRefSchema).min(1),
    expiresAt: z.iso.datetime({ offset: true }),
    authorization: ApprovalAuthorizationSchema,
  })
  .strict();
export type WaiverDefinition = z.infer<typeof WaiverDefinitionSchema>;

/** The shared admission IR document (V1). It holds only data and references. */
export const AdmissionIrDocumentV1Schema = z
  .object({
    irVersion: z.literal(SHARED_ADMISSION_IR_VERSION),
    workflowId: SharedStableIdSchema,
    policies: z.array(PolicyDefinitionSchema),
    requirements: z.array(RequirementDefinitionSchema),
    edges: z.array(EdgeDefinitionSchema),
    waivers: z.array(WaiverDefinitionSchema),
  })
  .strict();
export type AdmissionIrDocumentV1 = z.infer<typeof AdmissionIrDocumentV1Schema>;

/** The structural parse result. It does not resolve references. */
export type AdmissionIrParseResult =
  | { readonly ok: true; readonly document: AdmissionIrDocumentV1 }
  | { readonly ok: false; readonly error: z.ZodError };

/**
 * Validates the structure of an untrusted value against the shared IR schema.
 * It enforces strict objects and closed unions, but it does not resolve references.
 */
export function parseAdmissionIrDocument(input: unknown): AdmissionIrParseResult {
  const result = AdmissionIrDocumentV1Schema.safeParse(input);
  return result.success
    ? { ok: true, document: result.data }
    : { ok: false, error: result.error };
}

/** The JSON Schema for the shared IR document, from the `zodToJsonSchema` draft 2020-12 chokepoint. */
export function admissionIrJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(AdmissionIrDocumentV1Schema) as Record<string, unknown>;
}
