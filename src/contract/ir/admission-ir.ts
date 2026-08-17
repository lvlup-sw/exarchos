// ─── Shared admission IR — authored wire model (P03-06) ──────────────────────
//
// PROGRAM-03, API-007. The SHARED admission IR is the cross-product wire model
// that `Strategos.Contracts` / `WorkflowDefinitionV1` own: admission-policy
// definitions and references, the CLOSED edge-condition node set, evidence
// requirement models, waiver + approval wire models, and ACTION REFERENCES.
//
// ## Single authored source (no TypeSpec toolchain offline)
//
// The program's design authority names `Strategos.Contracts` TypeSpec as the
// generative source. There is NO TypeSpec compiler vendored in this offline
// environment (no `.tsp` files, no `@typespec/*` packages resolve). Rather than
// fake a TypeSpec build, this module is the SINGLE AUTHORED SOURCE: a set of
// Zod schemas from which the checked-in JSON Schema is DERIVED deterministically
// (`admission-ir-schema.ts`, via the `zodToJsonSchema` chokepoint). The Zod
// schemas here ARE the Exarchos runtime validators; the generated JSON Schema is
// the portable, cross-product artifact. The round-trip harness proves the two
// accept/reject the same fixtures (`roundtrip.test.ts`).
//
// ## Closed by construction (no shell / closure / harness syntax / binding)
//
// Every object below is `.strict()` and every leaf is a scalar, a closed enum,
// a stable-id string, or the closed 7-node edge-condition union. There is NO
// `z.any()`, `z.unknown()`, `z.function()`, or open-value field anywhere — so a
// document is STRUCTURALLY INCAPABLE of carrying a shell command, an arbitrary
// closure, harness-specific syntax, or an Exarchos implementation binding. An
// `expression`/`command`/`script`/`exec` escape hatch is rejected as an unknown
// property; an unknown node kind is rejected by the closed union. This mirrors
// the no-escape-hatch property of the runtime edge-condition compiler
// (`workflow/admission/edge-condition.ts`, P06-02) and the `.strict()` sandbox
// of `architecture/invariant-schema.ts`.
//
// ## References vs bindings (the closure seam)
//
// The IR carries action / policy / requirement REFERENCES — stable string ids,
// never handlers, closures, or serializable descriptors. Resolving a reference
// to a real Exarchos binding is the CONSUMER's job (`references.ts` resolves
// action refs against the P03-04 ActionId source); the wire never carries the
// binding itself. Dangling references are rejected by `references.ts`, not by
// this structural schema (JSON Schema cannot express cross-object resolution).
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { zodToJsonSchema } from '../../utils/json-schema.js';

/** The shared admission IR wire-contract version (append-only successors later). */
export const SHARED_ADMISSION_IR_VERSION = '1' as const;

// ─── Stable ids and references ───────────────────────────────────────────────

/**
 * A provider-neutral stable id. Deliberately the SAME character class as the
 * runtime `StableIdValueSchema` (`workflow/admission/types.ts`) — letters,
 * digits, dot, underscore, colon, hyphen, non-empty, no leading punctuation —
 * so a shell fragment (`; rm -rf /`), a path, or an arbitrary expression fails
 * the pattern. The equality of the two id vocabularies is asserted in
 * `roundtrip.test.ts` so a runtime drift trips a test rather than silently
 * widening the shared surface.
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
 * A reference to an Exarchos action by its stable `<tool>.<action>` ActionId.
 * Structurally just a stable id; resolution against the REAL ActionId set
 * (P03-04) is done by `references.ts`, never carried on the wire as a binding.
 */
export const ActionRefSchema = SharedStableIdSchema;

// ─── Evidence subject kinds (mirror of runtime EvidenceSubjectV1) ────────────

/**
 * The closed evidence-subject kinds an evidence-requirement model may target.
 * Mirrors the runtime `EvidenceSubjectV1` discriminant set; equality asserted
 * in `roundtrip.test.ts`.
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

// ─── Closed edge-condition node set (mirror of P06-02) ───────────────────────

/**
 * The exhaustive, closed edge-condition node kinds — the SHARED expression of
 * the runtime closed AST (`EDGE_CONDITION_NODE_KINDS`, P06-02). Equality with
 * the runtime constant is asserted in `roundtrip.test.ts`, so adding a node
 * kind to one side without the other trips a test.
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

/** The closed scalar leaf: string, number, or boolean — never an object/closure. */
const FactScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const NonEmptyStringSchema = z.string().min(1);

/**
 * Static shape of the closed edge-condition AST. Declared explicitly because
 * `z.lazy` cannot infer a recursive type; kept in lockstep with
 * {@link EdgeConditionNodeSchema}.
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
 * The closed edge-condition AST as a Zod schema. Each arm is `.strict()`, so an
 * escape-hatch property (`expression`, `command`, `script`, …) is rejected; a
 * node whose `kind` is not one of the seven fails the union. Recursion is via
 * `z.lazy` for the `all`/`any`/`not` combinators.
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
 * The reference declaration carried alongside a condition so the CONSUMER can
 * compile it with the runtime `compileEdgeCondition`. Fields map a declared
 * fact name to its scalar type; events are declared observable identities.
 */
export const EdgeConditionDeclarationSchema = z
  .object({
    fields: z.record(NonEmptyStringSchema, z.enum(IR_FACT_TYPES)),
    events: z.array(NonEmptyStringSchema),
  })
  .strict();
export type EdgeConditionDeclaration = z.infer<typeof EdgeConditionDeclarationSchema>;

// ─── Admission policy definitions and references ─────────────────────────────

/**
 * An admission-policy DEFINITION. `requires` references requirement definitions
 * (by id) in the same document; `onDeny` references Exarchos ActionIds that may
 * remediate a denial. Both are references — never inline handlers or commands.
 */
export const PolicyDefinitionSchema = z
  .object({
    policyId: SharedStableIdSchema,
    requires: z.array(RequirementRefSchema),
    onDeny: z.array(ActionRefSchema),
  })
  .strict();
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;

// ─── Evidence requirement models (mirror of runtime AdmissionRequirementV1) ──

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
 * The closed evidence-requirement kinds — mirror of the runtime
 * `AdmissionRequirementV1` discriminant set. Set-equality with the runtime union
 * is asserted in `roundtrip.test.ts`.
 */
export const IR_REQUIREMENT_KINDS = ['gate-evidence', 'approval', 'corroboration'] as const;
export type IrRequirementKind = (typeof IR_REQUIREMENT_KINDS)[number];

/**
 * The closed evidence-requirement model. Kinds mirror the runtime
 * `AdmissionRequirementV1` discriminants (`gate-evidence` / `approval` /
 * `corroboration`); `corroboration.sourceRequirementId` is a requirement
 * reference (a dangling-reference surface).
 */
export const RequirementDefinitionSchema = z.discriminatedUnion('kind', [
  GateEvidenceRequirementSchema,
  ApprovalRequirementSchema,
  CorroborationRequirementSchema,
]);
export type RequirementDefinition = z.infer<typeof RequirementDefinitionSchema>;

// ─── Edge definitions (closed condition + policy ref + action ref) ───────────

/** The Exarchos action that EFFECTS a transition — a reference, never a binding. */
const EdgeEffectSchema = z.object({ actionRef: ActionRefSchema }).strict();

/**
 * A workflow edge: a closed condition + its reference declaration, the
 * admission policy that gates it (`admits` — a policy reference), and the action
 * that effects it (`effect.actionRef` — an action reference).
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

// ─── Waiver + approval wire models (mirror of runtime WaiverScopeV1) ─────────

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
 * A waiver DEFINITION: its scope, the requirements it waives (references), an
 * ISO expiry, and the approval authorization required to issue it. `waives`
 * references requirement definitions (a dangling-reference surface).
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

// ─── The whole document ──────────────────────────────────────────────────────

/**
 * The shared admission IR document (V1). A closed, wire-serializable model of a
 * workflow's admission surface — policies, requirements, gated edges, and
 * waivers — carrying only data and references.
 */
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

/** Structural parse result (does NOT resolve references — see `references.ts`). */
export type AdmissionIrParseResult =
  | { readonly ok: true; readonly document: AdmissionIrDocumentV1 }
  | { readonly ok: false; readonly error: z.ZodError };

/**
 * Structurally validate an untrusted value against the shared IR schema. This
 * is the Exarchos runtime validator half of the round-trip; it enforces the
 * closure property (strict objects, closed unions) but NOT reference
 * resolution.
 */
export function parseAdmissionIrDocument(input: unknown): AdmissionIrParseResult {
  const result = AdmissionIrDocumentV1Schema.safeParse(input);
  return result.success
    ? { ok: true, document: result.data }
    : { ok: false, error: result.error };
}

/**
 * The generated JSON Schema for the shared IR document, emitted through the
 * `zodToJsonSchema` draft-2020-12 chokepoint. Deterministic: the same schema
 * source yields a byte-identical object on any machine.
 */
export function admissionIrJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(AdmissionIrDocumentV1Schema) as Record<string, unknown>;
}
