/**
 * Compiles one delegation batch into a capsule. The module is pure: the handler reads state, resolves the catalog, and passes in the versions and the timestamp.
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
import { TaskCompletedData, type DesignRevised } from '../../events/schemas.js';
import { findActionInRegistry } from '../../registry.js';
import { VERIFICATION_GATE_NAMES, type RiskTier } from '../../workflow/verification-policy.js';
import {
  FACT_DECLARATION,
  TASKS_COMPLETE_CONDITION,
} from '../../workflow/admission/built-in-workflow-ir.js';
import { bindCatalogInvariants, type CatalogInvariant } from './bind-authority.js';
import { builtInWorkflowAuthority } from './built-in-authority.js';
import { designVersionId } from './design-version.js';
import type { LoweredBuiltInDefinition } from './lower-definition.js';
import { DELEGATION_STEP_ID, type BatchTaskVerification, type DelegationBatch } from './partition-tasks.js';
import type { PrepareRefusal } from './types.js';

/**
 * Names the compiler that produced a capsule, so a reader can tell compilations apart.
 * The handler also keys its replay claim on this name, so a capsule of an earlier compiler is not replayed.
 * Raise the number when the compiler changes what it writes into a capsule.
 */
export const PREPARE_COMPILER_VERSION = 'exarchos-prepare-3';

/** The deviation kinds that a worker can propose when an assumption of the capsule does not hold. */
export const DELEGATION_DEVIATION_KINDS: readonly string[] = ['invalidated-assumption', 'missing-context'];

/**
 * The allowed deviation kinds that are material: an accepted deviation of such a kind revises the design.
 * A deviation for missing context does not revise the design, so that kind is absent.
 * The capsule pins this list, so settlement reads the kinds from the capsule that it judges.
 */
const DELEGATION_MATERIAL_DEVIATION_KINDS: readonly string[] = ['invalidated-assumption'];

/** The most accepted design changes that one capsule states. One more statement counts the rest. */
const MAX_BOUND_DESIGN_CHANGES = 8;

/** The most characters that a capsule keeps of a deviation statement, and of a proposed change. */
const DESIGN_CHANGE_TEXT_LIMIT = 280;

/** The most characters that a capsule keeps of the name of a deciding actor. */
const DESIGN_CHANGE_ACTOR_LIMIT = 80;

/** The mark that ends a text that the compiler cut. The mark counts in the limit. */
const CUT_MARK = '...';

/** The id of the provenance source that pins the design revision rows of the stream. */
const DESIGN_REVISIONS_SOURCE_ID = 'design-revisions';

/**
 * One accepted design change, as the settlement bundle of its revision holds it.
 * The handler reads it from custody. The compiler cuts the texts and writes the statement.
 */
export interface AcceptedDesignChange {
  /** The id of the deviation, as the revision row names it. */
  readonly deviationId: string;
  /** The actor of the decision that accepted the deviation. */
  readonly actor: string;
  /** What the worker found, in its words. */
  readonly statement: string;
  /** The tasks that the deviation names as affected. It is absent when the deviation names none. */
  readonly affectedTasks?: readonly string[];
  /** The change that the worker proposed. It is absent when the worker proposed none. */
  readonly proposedChange?: string;
}

/** One change that a capsule states, and the revision row that names it. */
interface BoundDesignChange {
  readonly revision: DesignRevised;
  readonly change: AcceptedDesignChange;
}

/**
 * The answer of one selection. A complete selection holds the changes that the capsule states, in
 * statement order, and the count of the changes that it does not state.
 * An incomplete selection names the next revision whose changes it needs, and one deviation that it lacks.
 */
type DesignChangeSelection =
  | { readonly complete: true; readonly bound: readonly BoundDesignChange[]; readonly leftOut: number }
  | { readonly complete: false; readonly unread: DesignRevised; readonly lacking: string };

/**
 * Selects the accepted changes that a capsule states. `accepted` holds the changes that the caller
 * read from the settlement bundles. A revision is read when `accepted` holds each deviation of its row.
 *
 * The first group holds each change that names a task of the batch, and the second group holds the rest.
 * `settle` writes each row with the tasks that its changes name. Thus only a row that names a task of the batch gives the first group.
 * The order and the reads rest on that property of a row.
 *
 * Each group has the newest revision first. In one revision, the order is that of the deviation ids on its row.
 * The first eight changes in that order are bound.
 *
 * The walk asks for a revision only while one of its changes can be bound.
 * Thus a caller that reads each revision that the selection asks for reads the bundles of the bound revisions only.
 */
export function selectDesignChanges(
  revisions: readonly DesignRevised[],
  batchTaskIds: readonly string[],
  accepted: readonly AcceptedDesignChange[],
): DesignChangeSelection {
  const inBatch = new Set(batchTaskIds);
  const namesBatchTask = (taskIds: readonly string[] = []): boolean =>
    taskIds.some((taskId) => inBatch.has(taskId));
  const given = new Map(accepted.map((change) => [change.deviationId, change]));
  const newestFirst = [...revisions].sort((a, b) => b.nextDesignVersion - a.nextDesignVersion);

  const bound: BoundDesignChange[] = [];
  for (const firstGroup of [true, false]) {
    for (const revision of newestFirst) {
      if (bound.length >= MAX_BOUND_DESIGN_CHANGES) break;
      const rowNamesBatchTask = namesBatchTask(revision.affectedTasks);
      if (firstGroup && !rowNamesBatchTask) continue;
      const changes: AcceptedDesignChange[] = [];
      for (const deviationId of revision.deviationIds) {
        const change = given.get(deviationId);
        if (change === undefined) return { complete: false, unread: revision, lacking: deviationId };
        changes.push(change);
      }
      for (const change of changes) {
        if (bound.length >= MAX_BOUND_DESIGN_CHANGES) break;
        const inFirstGroup = rowNamesBatchTask && namesBatchTask(change.affectedTasks);
        if (inFirstGroup === firstGroup) bound.push({ revision, change });
      }
    }
  }
  const named = revisions.reduce((count, revision) => count + revision.deviationIds.length, 0);
  return { complete: true, bound, leftOut: named - bound.length };
}

export interface CompileCapsuleInput {
  readonly workflowId: string;
  readonly capsuleVersion: number;
  readonly lowered: LoweredBuiltInDefinition;
  readonly batch: DelegationBatch;
  readonly catalogInvariants: readonly CatalogInvariant[];
  /** The workflow's design artifact reference, when it records one. */
  readonly designRef: string | undefined;
  /**
   * The design version of the stream: the revision counter that the handler folds from its events.
   * It starts at 1, and each recorded design revision moves it. The capsule identity carries its id.
   */
  readonly designVersion: number;
  /**
   * The design revision rows of the stream, in commit order. The capsule states the changes that
   * {@link selectDesignChanges} binds from them, and its provenance pins all the rows.
   */
  readonly designRevisions: readonly DesignRevised[];
  /**
   * The accepted changes of the bound revisions, which the handler read from their settlement bundles.
   * The compilation is refused when it lacks a change of a revision that the selection asks for.
   */
  readonly acceptedChanges: readonly AcceptedDesignChange[];
  /**
   * The compiler name that the capsule records in its provenance.
   * The handler passes the name that it keys the replay claim on, so the record and the claim agree.
   */
  readonly compilerVersion: string;
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
 * Cuts a text to a limit. A cut text ends with the cut mark, and the mark counts in the limit.
 * The cut does not split a surrogate pair, so the text stays well formed.
 */
function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = limit - CUT_MARK.length;
  const last = text.charCodeAt(end - 1);
  const kept = last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
  return `${text.slice(0, kept)}${CUT_MARK}`;
}

/**
 * The statement of one accepted change. It names the design version, the actor, the proposed change and the deviation.
 * Each text has its own limit, so a long text cannot push another text out.
 * Each text is in JSON quotes. Thus the statement is one line, and the words of the worker have clear bounds.
 */
function designChangeStatement(revision: DesignRevised, change: AcceptedDesignChange): string {
  const quoted = (text: string, limit: number): string => JSON.stringify(cutTo(text, limit));
  return (
    `Design version ${revision.nextDesignVersion} holds an accepted change. ` +
    `Decided by ${quoted(change.actor, DESIGN_CHANGE_ACTOR_LIMIT)}. ` +
    (change.proposedChange !== undefined
      ? `Proposed change: ${quoted(change.proposedChange, DESIGN_CHANGE_TEXT_LIMIT)}. `
      : '') +
    `Deviation: ${quoted(change.statement, DESIGN_CHANGE_TEXT_LIMIT)}.`
  );
}

type DesignChangeStatements =
  | { readonly ok: true; readonly statements: readonly { statement: string }[] }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/**
 * The statements of the accepted design changes: one for each bound change, in selection order.
 * One more statement counts the changes that the capsule does not state.
 * The compilation is refused when the input lacks a change that the selection asks for.
 * Thus a capsule never states a placeholder.
 */
function designChangeStatements(
  input: CompileCapsuleInput,
  batchTaskIds: readonly string[],
): DesignChangeStatements {
  const selection = selectDesignChanges(input.designRevisions, batchTaskIds, input.acceptedChanges);
  if (!selection.complete) {
    return {
      ok: false,
      refusal: {
        code: 'REVISION_UNREADABLE',
        message:
          `the revision to design version ${selection.unread.nextDesignVersion} names the accepted deviation ` +
          `${JSON.stringify(selection.lacking)}, and the compilation was not given that change, so the capsule ` +
          'cannot state it',
      },
    };
  }
  const statements = selection.bound.map(({ revision, change }) =>
    statement(designChangeStatement(revision, change)),
  );
  if (selection.leftOut > 0) {
    statements.push(
      statement(
        `${selection.leftOut} more accepted design change(s) are not stated in this capsule. ` +
          'The design.revised rows of the workflow stream name each one.',
      ),
    );
  }
  return { ok: true, statements };
}

/**
 * Compiles one delegation batch, or refuses it.
 * The completion predicate is the task-completion condition, parsed through the capsule condition schema, so the declares block matches the node the capsule carries.
 * The steps that follow the batch in the pinned definition become non-goals.
 * The identity carries the id of the design version, which is the revision counter of the stream.
 * The digest of the design reference is a provenance source, and it is not part of the identity.
 * The settlement contract freezes the tier and the boundary flag of each task, so settlement does not read them from the claim.
 *
 * The rationale states the design of record, and then the accepted changes that the revision rows name.
 * The digest of the revision rows is a provenance source, and a stream with no revision has no such source.
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

  const designChanges = designChangeStatements(input, batchTaskIds);
  if (!designChanges.ok) return { ok: false, refusal: designChanges.refusal };

  const sources = [
    { sourceId: 'workflow-definition', digest: lowered.definitionVersion },
    { sourceId: 'plan-tasks', digest: contentDigest(batch) },
    { sourceId: 'authority', digest: contentDigest(authority) },
    ...(designRef !== undefined ? [{ sourceId: 'design-record', digest: contentDigest(designRef) }] : []),
    ...(input.designRevisions.length > 0
      ? [{ sourceId: DESIGN_REVISIONS_SOURCE_ID, digest: contentDigest(input.designRevisions) }]
      : []),
  ];

  const document = {
    capsuleSchemaVersion: '1',
    identity: {
      workflowId,
      definitionVersion: lowered.definitionVersion,
      designVersion: designVersionId(input.designVersion),
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
      rationale: [
        ...(designRef !== undefined ? [statement(`The design of record is ${designRef}.`)] : []),
        ...designChanges.statements,
      ],
      patterns: verificationPatterns(batch, input.verificationSequence),
      glossary: [],
    },
    ...(input.executionProfile.capabilities.length > 0
      ? { executionProfile: { capabilities: [...input.executionProfile.capabilities] } }
      : {}),
    provenance: {
      sources,
      compiledAt: input.compiledAt,
      compilerVersion: input.compilerVersion,
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
