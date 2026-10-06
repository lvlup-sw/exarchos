/**
 * Compiles one delegation batch into a capsule. The module is pure: the handler reads state, resolves the catalog, and passes in the version and the timestamp.
 *
 * The stages run in this order:
 * - normalize: the caller lowers the built-in machine into a kernel definition. Its digest is the `definitionVersion` of the capsule.
 * - bind: the built-in authority, with the catalog invariants on top.
 * - partition: the outstanding tasks of the plan, already cut into a batch.
 * - lower: the execution profile, which holds the capabilities that the calls of the plane need.
 * - validate: the published contract, then each reference against the pinned definition.
 *
 * A capsule that fails validation is refused, never repaired. The cause is a plan that the batch cannot express, such as a dependency cycle, or a compiler defect.
 */

import { z } from 'zod';

import { collectConditionRefs, resolveCapsuleReferences } from '../../contract/capsule/capsule-references.js';
import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../contract/capsule/exarchos-capsule.js';
import { EdgeConditionNodeSchema } from '../../contract/ir/admission-ir.js';
import { TaskCompletedData } from '../../events/schemas.js';
import { findActionInRegistry } from '../../registry.js';
import { VERIFICATION_GATE_NAMES, type RiskTier } from '../../workflow/verification-policy.js';
import {
  FACT_DECLARATION,
  TASKS_COMPLETE_CONDITION,
} from '../../workflow/admission/built-in-workflow-ir.js';
import { bindCatalogInvariants, type CatalogInvariant } from './bind-authority.js';
import { builtInWorkflowAuthority } from './built-in-authority.js';
import type { LoweredBuiltInDefinition } from './lower-definition.js';
import { DELEGATION_STEP_ID, type BatchTaskVerification, type DelegationBatch } from './partition-tasks.js';
import type { PrepareRefusal } from './types.js';

/** Names the compiler that produced a capsule, so a reader can tell compilations apart. */
export const PREPARE_COMPILER_VERSION = 'exarchos-prepare-1';

/** The deviation kinds that a worker can propose when an assumption of the capsule does not hold. */
export const DELEGATION_DEVIATION_KINDS: readonly string[] = ['invalidated-assumption', 'missing-context'];

/**
 * The allowed deviation kinds that are material: an accepted deviation of such a kind revises the design.
 * A deviation for missing context does not revise the design, so that kind is absent.
 * The capsule pins this list, so settlement reads the kinds from the capsule that it judges.
 */
const DELEGATION_MATERIAL_DEVIATION_KINDS: readonly string[] = ['invalidated-assumption'];

export interface CompileCapsuleInput {
  readonly workflowId: string;
  readonly capsuleVersion: number;
  readonly lowered: LoweredBuiltInDefinition;
  readonly batch: DelegationBatch;
  readonly catalogInvariants: readonly CatalogInvariant[];
  /** The workflow's design artifact reference, when it records one. */
  readonly designRef: string | undefined;
  /**
   * The branch that each task in the batch forks from: the integration branch of the workflow,
   * which the handler resolves. It is frozen into the verification terms of each task, so the
   * kill probe measures the task diff from its start.
   */
  readonly baseRef: string;
  /**
   * The capabilities that a runtime must hold to run this batch through the plane.
   * The handler derives them from the registry. An empty list attaches no profile.
   */
  readonly executionProfile: { readonly capabilities: readonly string[] };
  /**
   * The gates that verify a task at a given tier, with the project overrides applied.
   * The handler resolves them through the policy composer, so the capsule states the sequence that the gate routing uses.
   */
  readonly verificationSequence: (riskTier: RiskTier, boundaryTouching: boolean) => readonly string[];
  readonly compiledAt: string;
}

export type CompileOutcome =
  | { readonly ok: true; readonly capsule: ExarchosCapsuleV1 }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

type CapsuleFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

function capsuleFieldTypeOf(schema: z.core.$ZodType): CapsuleFieldType | undefined {
  if (schema instanceof z.ZodOptional) return capsuleFieldTypeOf(schema.unwrap());
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodArray) return 'array';
  if (schema instanceof z.ZodObject) return 'object';
  return undefined;
}

/**
 * The fields of the completion record that a runtime does not return, because settlement derives them.
 * Settlement produces `evidence` and `verified` when it runs the verification of the task. If a runtime returns them, the runtime certifies its own work.
 * A claim names its task outside its fields, so `taskId` is not a result field.
 */
const SETTLEMENT_DERIVED_FIELDS: ReadonlySet<string> = new Set(['taskId', 'evidence', 'verified']);

/**
 * The result shape that each delegated task returns: `worktreePath`, `branch`, then each task-completion schema field that settlement does not derive.
 * `worktreePath` is not on that schema. `task_complete` copies it from the result onto the fact.
 * `worktreePath` is required, because settlement runs the verification of the task against that worktree.
 * `branch` is for the gates that diff against a base.
 * The function throws when a schema field has a type that the flat capsule field vocabulary cannot carry.
 */
function delegatedTaskResultFields(): { name: string; type: CapsuleFieldType; required: boolean }[] {
  const fields: { name: string; type: CapsuleFieldType; required: boolean }[] = [
    { name: 'worktreePath', type: 'string', required: true },
    { name: 'branch', type: 'string', required: false },
  ];
  for (const [name, schema] of Object.entries(TaskCompletedData.shape)) {
    if (SETTLEMENT_DERIVED_FIELDS.has(name)) continue;
    const type = capsuleFieldTypeOf(schema);
    if (type === undefined) {
      throw new Error(
        `the task-completion field '${name}' has a type the capsule's flat field vocabulary cannot carry`,
      );
    }
    fields.push({ name, type, required: !(schema instanceof z.ZodOptional) });
  }
  return fields;
}

/**
 * The evidence kinds that a claim can cite: the gate class of each ladder gate, from its registration.
 * The reference beside a cited kind must resolve to a row of that class on the stream. A claim points at evidence and does not carry it.
 */
function delegatedEvidenceKinds(): string[] {
  return VERIFICATION_GATE_NAMES.map((name) => {
    const gateClass = findActionInRegistry('exarchos_orchestrate', name)?.gate?.gateClass;
    if (typeof gateClass !== 'string' || gateClass.length === 0) {
      throw new Error(`the ladder gate '${name}' declares no gate class to admit evidence under`);
    }
    return gateClass;
  });
}

function statement(text: string): { statement: string } {
  return { statement: text };
}

/**
 * The distinct verification profiles of the batch tasks, in one fixed order.
 * The pattern statements of the capsule and the replay key of the compilation both use this list, so they state the same terms.
 */
export function verificationProfiles(batch: DelegationBatch): readonly BatchTaskVerification[] {
  const profiles = new Map<string, BatchTaskVerification>();
  for (const task of batch.tasks) {
    const key = `${task.verification.riskTier}|${task.verification.boundaryTouching}`;
    if (!profiles.has(key)) profiles.set(key, task.verification);
  }
  return [...profiles.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, profile]) => profile);
}

/**
 * One statement for each verification profile in the batch. Each statement names the gates that settlement runs for that profile.
 * The capsule binds them as knowledge, so the harness can tell each worker how settlement judges its work.
 */
function verificationPatterns(
  batch: DelegationBatch,
  sequenceOf: CompileCapsuleInput['verificationSequence'],
): { statement: string }[] {
  return verificationProfiles(batch).map((profile) =>
    statement(
      `A task at riskTier=${profile.riskTier}, boundaryTouching=${profile.boundaryTouching} is ` +
        `verified at settlement by: ${sequenceOf(profile.riskTier, profile.boundaryTouching).join(', ')}.`,
    ),
  );
}

/**
 * Compiles one delegation batch, or refuses it.
 * The completion predicate is the task-completion condition, parsed through the capsule condition schema, so the declares block matches the node the capsule carries.
 * The steps that follow the batch in the pinned definition become non-goals.
 * `designVersion` pins the digest of the design reference, not the bytes of the design record.
 * The settlement contract freezes the tier and the boundary flag of each task, so settlement does not read them from the claim.
 */
export function compileDelegationCapsule(input: CompileCapsuleInput): CompileOutcome {
  const { workflowId, capsuleVersion, lowered, batch, designRef } = input;

  const authority = bindCatalogInvariants(builtInWorkflowAuthority(), input.catalogInvariants);

  const condition = EdgeConditionNodeSchema.parse(TASKS_COMPLETE_CONDITION.node);
  const facts: { ref: string; at: string }[] = [];
  const events: { ref: string; at: string }[] = [];
  collectConditionRefs(condition, 'condition', facts, events);
  const declaredFields: Record<string, 'string' | 'number' | 'boolean'> = {};
  for (const fact of facts) {
    const type = FACT_DECLARATION.fields[fact.ref];
    if (type !== undefined) declaredFields[fact.ref] = type;
  }

  const downstream = [
    ...new Set(
      lowered.definition.transitions
        .filter((t) => t.fromStepId === DELEGATION_STEP_ID && t.toStepId !== DELEGATION_STEP_ID)
        .map((t) => t.toStepId),
    ),
  ];

  const resultFields = delegatedTaskResultFields();
  const batchTaskIds = batch.tasks.map((task) => task.taskId);

  const sources = [
    { sourceId: 'workflow-definition', digest: lowered.definitionVersion },
    { sourceId: 'plan-tasks', digest: contentDigest(batch) },
    { sourceId: 'authority', digest: contentDigest(authority) },
    ...(designRef !== undefined ? [{ sourceId: 'design-record', digest: contentDigest(designRef) }] : []),
  ];

  const document = {
    capsuleSchemaVersion: '1',
    identity: {
      workflowId,
      definitionVersion: lowered.definitionVersion,
      designVersion: `design-${contentDigest(designRef ?? null).slice(0, 16)}`,
      capsuleVersion,
    },
    intent: {
      goals: [
        statement(
          `Complete the ${batch.tasks.length} outstanding task(s) of workflow '${workflowId}'.`,
        ),
      ],
      nonGoals: downstream.map((step) =>
        statement(`The work of the '${step}' step, which follows this batch.`),
      ),
      successCriteria: batchTaskIds.map((taskId) =>
        statement(`Task '${taskId}' returns a result this capsule's settlement contract accepts.`),
      ),
    },
    authority,
    graph: {
      tasks: batch.tasks.map((task) => ({ taskId: task.taskId, title: task.title, stepId: task.stepId })),
      dependencies: batch.dependencies.map((edge) => ({ ...edge })),
      joins: batch.joins.map((join) => ({ joinId: join.joinId, waitsFor: [...join.waitsFor], mode: 'all' })),
      completionPredicate: {
        condition,
        declares: { fields: declaredFields, events: [...new Set(events.map((event) => event.ref))] },
      },
    },
    contracts: {
      taskInputs: {},
      taskResults: Object.fromEntries(batchTaskIds.map((taskId) => [taskId, resultFields])),
      evidenceKinds: delegatedEvidenceKinds(),
      deviationEnvelope: {
        allowedDeviationKinds: [...DELEGATION_DEVIATION_KINDS],
        materialDeviationKinds: [...DELEGATION_MATERIAL_DEVIATION_KINDS],
        requiresApproval: true,
      },
    },
    knowledge: {
      mode: 'eager',
      rationale: designRef !== undefined ? [statement(`The design of record is ${designRef}.`)] : [],
      patterns: verificationPatterns(batch, input.verificationSequence),
      glossary: [],
    },
    ...(input.executionProfile.capabilities.length > 0
      ? { executionProfile: { capabilities: [...input.executionProfile.capabilities] } }
      : {}),
    provenance: {
      sources,
      compiledAt: input.compiledAt,
      compilerVersion: PREPARE_COMPILER_VERSION,
    },
    settlementContract: {
      requiredResults: [...batch.requiredResults],
      taskVerification: Object.fromEntries(
        batch.tasks.map((task) => [task.taskId, { ...task.verification, baseRef: input.baseRef }]),
      ),
    },
  };

  const parsed = ExarchosCapsuleV1Schema.safeParse(document);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        code: 'CAPSULE_UNSOUND',
        message:
          'the compiled capsule does not satisfy the published capsule contract: ' +
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      },
    };
  }

  const references = resolveCapsuleReferences(parsed.data, { definition: lowered.definition });
  if (!references.ok) {
    return {
      ok: false,
      refusal: {
        code: 'CAPSULE_UNSOUND',
        message:
          'the compiled capsule does not resolve against the definition it pins: ' +
          references.violations.map((v) => `${v.at}: ${v.message}`).join('; '),
      },
    };
  }

  return { ok: true, capsule: parsed.data };
}
