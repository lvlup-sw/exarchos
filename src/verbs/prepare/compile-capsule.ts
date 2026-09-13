// ─── Compiling one delegation batch into a capsule ───────────────────────────
//
// PURE. No store, no filesystem, no clock: the handler reads state, resolves the
// catalog, picks the version and the timestamp, and hands them in. That keeps
// the compilation testable against a table of inputs, and it keeps the one
// question this module answers — "what are the terms of this batch?" —
// separate from the questions of where the inputs came from and where the
// answer is kept.
//
// The stages, in the order they run:
//
//   normalize   the built-in machine is lowered into a kernel definition
//               before this module is called; its digest is the capsule's
//               `definitionVersion`
//   bind        the built-in authority, with the catalog's invariants on top
//   partition   the plan's outstanding tasks, already cut into a batch
//   lower       nothing is attached for a runtime yet: the capsule carries no
//               execution profile, and a harness schedules the batch however
//               its dependencies allow
//   validate    the published contract, then every reference — against the
//               definition the capsule pins, so a task naming a step that
//               definition lacks is refused here rather than at settlement
//
// A capsule that fails validation is refused, never repaired. The failure is
// either a plan the batch cannot express, such as a dependency cycle, or a
// defect in this compiler, and neither is fixed by emitting something that
// happens to parse.

import { z } from 'zod';

import { collectConditionRefs, resolveCapsuleReferences } from '../../contract/capsule/capsule-references.js';
import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../contract/capsule/exarchos-capsule.js';
import { EdgeConditionNodeSchema } from '../../contract/ir/admission-ir.js';
import { TaskCompletedData } from '../../events/schemas.js';
import {
  FACT_DECLARATION,
  TASKS_COMPLETE_CONDITION,
} from '../../workflow/admission/built-in-workflow-ir.js';
import { bindCatalogInvariants, type CatalogInvariant } from './bind-authority.js';
import { builtInWorkflowAuthority } from './built-in-authority.js';
import type { LoweredBuiltInDefinition } from './lower-definition.js';
import { DELEGATION_STEP_ID, type DelegationBatch } from './partition-tasks.js';
import type { PrepareRefusal } from './types.js';

/** Names the compiler that produced a capsule, so a reader can tell compilations apart. */
export const PREPARE_COMPILER_VERSION = 'exarchos-prepare-1';

/** What a worker may propose when it finds the capsule's assumptions do not hold. */
export const DELEGATION_DEVIATION_KINDS: readonly string[] = ['invalidated-assumption', 'missing-context'];

export interface CompileCapsuleInput {
  readonly workflowId: string;
  readonly capsuleVersion: number;
  readonly lowered: LoweredBuiltInDefinition;
  readonly batch: DelegationBatch;
  readonly catalogInvariants: readonly CatalogInvariant[];
  /** The workflow's design artifact reference, when it records one. */
  readonly designRef: string | undefined;
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
 * The result shape every delegated task returns: the task-completion record's
 * own fields, read off its schema rather than listed again here.
 *
 * Two departures, both deliberate. `taskId` is not a result field — a claim
 * names its task outside its fields. And `evidence` is REQUIRED although the
 * record keeps it optional: the record has to accept completions written before
 * evidence existed, while a capsule is compiled now, under an authority that
 * says a task is complete only when its result arrives with evidence.
 */
function delegatedTaskResultFields(): { name: string; type: CapsuleFieldType; required: boolean }[] {
  const fields: { name: string; type: CapsuleFieldType; required: boolean }[] = [];
  for (const [name, schema] of Object.entries(TaskCompletedData.shape)) {
    if (name === 'taskId') continue;
    const type = capsuleFieldTypeOf(schema);
    if (type === undefined) {
      throw new Error(
        `the task-completion field '${name}' has a type the capsule's flat field vocabulary cannot carry`,
      );
    }
    fields.push({ name, type, required: name === 'evidence' || !(schema instanceof z.ZodOptional) });
  }
  return fields;
}

/** The evidence kinds a completion may cite, read off the completion record's own enum. */
function delegatedEvidenceKinds(): string[] {
  return [...TaskCompletedData.shape.evidence.unwrap().shape.type.options];
}

function statement(text: string): { statement: string } {
  return { statement: text };
}

/** Compile one delegation batch, or refuse it. */
export function compileDelegationCapsule(input: CompileCapsuleInput): CompileOutcome {
  const { workflowId, capsuleVersion, lowered, batch, designRef } = input;

  const authority = bindCatalogInvariants(builtInWorkflowAuthority(), input.catalogInvariants);

  // The completion predicate is the task-completion obligation itself, taken
  // from the edge vocabulary that enforces it. It is parsed through the
  // capsule's own condition schema so the declares block below is built from
  // exactly the node the capsule will carry.
  const condition = EdgeConditionNodeSchema.parse(TASKS_COMPLETE_CONDITION.node);
  const facts: { ref: string; at: string }[] = [];
  const events: { ref: string; at: string }[] = [];
  collectConditionRefs(condition, 'condition', facts, events);
  const declaredFields: Record<string, 'string' | 'number' | 'boolean'> = {};
  for (const fact of facts) {
    const type = FACT_DECLARATION.fields[fact.ref];
    if (type !== undefined) declaredFields[fact.ref] = type;
  }

  // What follows this batch in the workflow is named as out of scope, read off
  // the pinned definition's own topology.
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
      // Pins the design RECORD this compilation referenced, by the digest of
      // that reference. It does not yet pin the record's bytes.
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
      tasks: batch.tasks.map((task) => ({ ...task })),
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
      deviationEnvelope: { allowedDeviationKinds: [...DELEGATION_DEVIATION_KINDS], requiresApproval: true },
    },
    knowledge: {
      mode: 'eager',
      rationale: designRef !== undefined ? [statement(`The design of record is ${designRef}.`)] : [],
      patterns: [],
      glossary: [],
    },
    provenance: {
      sources,
      compiledAt: input.compiledAt,
      compilerVersion: PREPARE_COMPILER_VERSION,
    },
    settlementContract: { requiredResults: [...batch.requiredResults] },
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
