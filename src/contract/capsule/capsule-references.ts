/**
 * Reference integrity for the Exarchos workflow capsule. The schema in `exarchos-capsule.ts` proves
 * that a capsule is closed. This module proves that it is resolvable. The round-trip guard compares
 * the schema with its JSON Schema projection, and JSON Schema cannot express cross-object
 * resolution. Thus these rules stay out of the schema.
 *
 * The pass resolves task refs to `graph.tasks`, checks that `graph.dependencies` is acyclic, and
 * resolves predicate facts and events to the `declares` block. Each required result must name a
 * task with a declared result shape. When the caller supplies the kernel definition, each `stepId`
 * must name a step of it. The kernel schema checks that definition, so this module does not
 * duplicate the kernel graph rules. A duplicate task or join id is also a violation.
 */

import { z } from 'zod';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import type { IrEdgeConditionNode } from '../ir/admission-ir.js';
import type { ExarchosCapsuleV1 } from './exarchos-capsule.js';
import { visitDeclaredObjects } from './kernel-derivation.js';

/**
 * Every kind of reference-integrity violation that this pass reports. It is a runtime roster, not a
 * type union, because no typecheck runs over `tests/unit`. The tests iterate the roster, so a new
 * kind with no fixture fails a test. It is a schema because the tool boundary validates verdicts.
 */
export const CapsuleReferenceViolationKindSchema = z.enum([
  'duplicate-task-id',
  'duplicate-join-id',
  'dangling-task-ref',
  'cyclic-dependency',
  'undeclared-fact',
  'undeclared-event',
  'unadjudicable-required-result',
  'dangling-step-ref',
  'unsound-kernel-definition',
  'compiler-semantics',
]);

/** The roster, in declaration order. */
export const CAPSULE_REFERENCE_VIOLATION_KINDS = CapsuleReferenceViolationKindSchema.options;

/** The kind of reference-integrity violation found in a capsule. */
export type CapsuleReferenceViolationKind = z.infer<typeof CapsuleReferenceViolationKindSchema>;

/** A single, path-annotated reference-integrity violation. */
export interface CapsuleReferenceViolation {
  readonly kind: CapsuleReferenceViolationKind;
  /** The offending reference or id value. */
  readonly ref: string;
  /** A JSON-ish path locating where the offending reference lives. */
  readonly at: string;
  readonly message: string;
}

/** The verdict from resolving every reference in a capsule. */
export interface CapsuleReferenceVerdict {
  /** True when there are zero violations. */
  readonly ok: boolean;
  readonly violations: readonly CapsuleReferenceViolation[];
}

/** Options for {@link resolveCapsuleReferences}. */
export interface ResolveCapsuleReferencesOptions {
  /**
   * The workflow definition that the capsule compiled from. A capsule pins its definition by digest
   * only, so step references resolve only when the caller supplies it. The kernel schema parses it
   * first.
   */
  readonly definition?: unknown;
}

/**
 * The keys under which the kernel declares a collection of steps, at any depth. Only these keys
 * count. Transition keys such as `fromStepId` do not, so a transition cannot make a dangling id
 * resolve.
 */
const STEP_COLLECTION_KEYS: ReadonlySet<string> = new Set(['steps', 'bodySteps']);
/**
 * Every step id that a kernel definition declares, at any depth. The walk follows the kernel
 * schema, not the document. `WorkflowDefinitionV1Schema` uses `z.looseObject`, so an accepted
 * definition can keep unknown objects. A key-name match alone can find a step id inside them, and
 * then a dangling step reference resolves.
 */
function collectStepIds(definition: unknown, into: Set<string>): void {
  visitDeclaredObjects(WorkflowDefinitionV1Schema, definition, (object, key) => {
    if (key === undefined || !STEP_COLLECTION_KEYS.has(key)) return;
    const stepId = object.get('stepId');
    if (typeof stepId === 'string' && stepId.length > 0) into.add(stepId);
  });
}

/**
 * Every fact field and event identity that a condition names, with its own path. The switch is
 * exhaustive over the closed condition union. A new kind without an arm is a compile error, not a
 * predicate that reads as fully declared.
 */
export function collectConditionRefs(
  node: IrEdgeConditionNode,
  at: string,
  facts: { ref: string; at: string }[],
  events: { ref: string; at: string }[],
): void {
  switch (node.kind) {
    case 'eventObserved':
      events.push({ ref: node.event, at: `${at}.event` });
      return;
    case 'factPresent':
    case 'factEquals':
    case 'counterCompare':
      facts.push({ ref: node.field, at: `${at}.field` });
      return;
    case 'all':
    case 'any':
      node.operands.forEach((child, i) =>
        collectConditionRefs(child, `${at}.operands[${i}]`, facts, events),
      );
      return;
    case 'not':
      collectConditionRefs(node.operand, `${at}.operand`, facts, events);
      return;
    default: {
      const unhandled: never = node;
      throw new Error(`capsule-references: unhandled condition kind ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Every dependency cycle, as the id sequence that closes it. The walk is iterative, so a large
 * capsule cannot overflow the stack. It skips edges to unknown tasks, because the dangling-ref
 * check reports them. Each cycle is reported once, keyed by its sorted members. Stable ids hold no
 * comma, so a comma-joined key is sound.
 */
function findDependencyCycles(
  taskIds: ReadonlySet<string>,
  edges: readonly { readonly from: string; readonly to: string }[],
): readonly (readonly string[])[] {
  const successors = new Map<string, string[]>();
  for (const id of taskIds) successors.set(id, []);
  for (const edge of edges) {
    if (!taskIds.has(edge.from) || !taskIds.has(edge.to)) continue;
    successors.get(edge.from)?.push(edge.to);
  }

  const UNVISITED = 0;
  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>([...taskIds].map((id) => [id, UNVISITED]));
  const path: string[] = [];
  const cycles: string[][] = [];
  const reported = new Set<string>();

  for (const root of taskIds) {
    if (state.get(root) !== UNVISITED) continue;
    const frames: { node: string; next: number }[] = [{ node: root, next: 0 }];
    state.set(root, ON_STACK);
    path.push(root);

    while (frames.length > 0) {
      const top = frames[frames.length - 1];
      if (top === undefined) break;
      const children = successors.get(top.node) ?? [];
      if (top.next >= children.length) {
        state.set(top.node, DONE);
        frames.pop();
        path.pop();
        continue;
      }
      const child = children[top.next];
      top.next += 1;
      if (child === undefined) continue;
      if (state.get(child) === ON_STACK) {
        const cycle = [...path.slice(path.indexOf(child)), child];
        const key = cycle.slice(0, -1).sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
        continue;
      }
      if (state.get(child) === DONE) continue;
      state.set(child, ON_STACK);
      path.push(child);
      frames.push({ node: child, next: 0 });
    }
  }
  return cycles;
}

/** Compiler-specific completeness does not change the historical structural decoder. */
function compilerSemantics(capsule: ExarchosCapsuleV1): CapsuleReferenceViolation[] {
  if (capsule.provenance.compilerVersion !== 'exarchos-prepare-8') return [];
  const violations: CapsuleReferenceViolation[] = [];
  const fail = (ref: string, at: string, message: string): void => {
    violations.push({ kind: 'compiler-semantics', ref, at, message });
  };
  const terms = capsule.settlementContract;
  const sources = capsule.provenance.sources.filter(source => source.sourceId === 'design-record');
  if (terms.verificationMode !== 'immutable-task-diff-v1' || terms.scope === undefined
      || terms.verificationProfile === undefined || terms.skipPhases === undefined || sources.length !== 1) {
    fail('exarchos-prepare-8', 'provenance.compilerVersion', 'Compiler 8 requires typed source, scope, profile, frozen skips and immutable verification.');
  }
  const taskIds = new Set(capsule.graph.tasks.map(task => task.taskId));
  const edgeKeys = new Set<string>();
  for (const edge of capsule.graph.dependencies) {
    const key = JSON.stringify([edge.from, edge.to]);
    if (edgeKeys.has(key)) fail(edge.to, 'graph.dependencies', 'A dependency occurs more than once.');
    edgeKeys.add(key);
  }
  const incoming = new Map<string, string[]>();
  for (const edge of capsule.graph.dependencies) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  const byDependent = new Map<string, typeof capsule.graph.joins>();
  for (const join of capsule.graph.joins) {
    if (join.forTaskId !== undefined) byDependent.set(join.forTaskId, [...(byDependent.get(join.forTaskId) ?? []), join]);
  }
  const stages = new Set<string>();
  const bases = new Set<string>();
  for (const [index, task] of capsule.graph.tasks.entries()) {
    const at = `graph.tasks[${index}]`;
    const context = task.taskContext;
    const verification = terms.taskVerification?.[task.taskId];
    if (task.stage === undefined || task.stepId !== task.stage.stepId || context === undefined
        || verification?.baseCommit === undefined) {
      fail(task.taskId, at, 'Compiler 8 requires a located stage, context and pinned task base.');
      continue;
    }
    stages.add(task.stage.stepId);
    const blockers = incoming.get(task.taskId) ?? [];
    bases.add(JSON.stringify([verification.baseRef, verification.baseCommit]));
    const result = capsule.contracts.taskResults[task.taskId];
    if (context.taskId !== task.taskId || context.title !== task.title || context.resultContractRef !== task.taskId
        || result === undefined || JSON.stringify(context.blockedBy) !== JSON.stringify(blockers)
        || context.riskTier !== verification.riskTier || context.boundaryTouching !== verification.boundaryTouching
        || context.source.digest !== sources[0]?.digest) {
      fail(task.taskId, at, 'The context must match its task, blockers, source, result contract and verification terms.');
    }
    const span = context.source.span;
    if (span.end <= span.start || span.endLine < span.startLine) fail(task.taskId, at, 'The source span must be nonempty and ordered.');
    const byteTerms: readonly [readonly string[], number][] = [
      [[context.title], 256], [[context.instructions], 8192], [context.acceptance, 2048],
      [[...context.files, ...context.testFiles, context.source.reference,
        ...Object.values(context.knowledgeSlice).flat()], 512],
    ];
    if (byteTerms.some(([values, limit]) => values.some(value => !value.trim() || Buffer.byteLength(value, 'utf8') > limit))
        || Buffer.byteLength(JSON.stringify({ context, resultContract: result }), 'utf8') > 24000) {
      fail(task.taskId, at, 'The full context and result contract exceed their UTF-8 byte bounds or contain blank text.');
    }
    if (blockers.length > 0 && !result?.some(field => field.name === 'forkCommit' && field.type === 'string' && field.required)) {
      fail(task.taskId, at, 'A dependent result must require its fork commit.');
    }
    const joins = byDependent.get(task.taskId) ?? [];
    if (blockers.length > 1) {
      const [join] = joins;
      if (joins.length !== 1 || join?.mode !== 'all' || JSON.stringify(join.waitsFor) !== JSON.stringify(blockers)) {
        fail(task.taskId, 'graph.joins', 'A fan-in requires exactly one all-mode join with its ordered direct blockers.');
      }
    } else if (joins.length !== 0) fail(task.taskId, 'graph.joins', 'Roots and single-blocker tasks have no fan-in join.');
  }
  if (bases.size !== 1) fail('base', 'settlementContract.taskVerification', 'All tasks share one pinned base coordinate.');
  if (stages.size !== 1) fail('stage', 'graph.tasks', 'All compiler-8 tasks belong to one implementation stage.');
  for (const join of capsule.graph.joins) {
    if (taskIds.has(join.joinId) || join.forTaskId === undefined || !taskIds.has(join.forTaskId)) {
      fail(join.joinId, 'graph.joins', 'Join ids cannot collide with tasks and each join must name its dependent.');
    }
  }
  return violations;
}

/**
 * Resolve every reference in a structurally valid capsule. It returns all violations, not only the
 * first. The function does not change the document and does no I/O.
 */
export function resolveCapsuleReferences(
  capsule: ExarchosCapsuleV1,
  opts: ResolveCapsuleReferencesOptions = {},
): CapsuleReferenceVerdict {
  const violations: CapsuleReferenceViolation[] = compilerSemantics(capsule);

  const taskIds = new Set<string>();
  capsule.graph.tasks.forEach((task, i) => {
    if (taskIds.has(task.taskId)) {
      violations.push({
        kind: 'duplicate-task-id',
        ref: task.taskId,
        at: `graph.tasks[${i}].taskId`,
        message: `duplicate task id ${JSON.stringify(task.taskId)} — an ambiguous reference target`,
      });
    }
    taskIds.add(task.taskId);
  });

  const joinIds = new Set<string>();
  capsule.graph.joins.forEach((join, i) => {
    if (joinIds.has(join.joinId)) {
      violations.push({
        kind: 'duplicate-join-id',
        ref: join.joinId,
        at: `graph.joins[${i}].joinId`,
        message: `duplicate join id ${JSON.stringify(join.joinId)} — an ambiguous reference target`,
      });
    }
    joinIds.add(join.joinId);
  });

  const requireTask = (ref: string, at: string): boolean => {
    if (taskIds.has(ref)) return true;
    violations.push({
      kind: 'dangling-task-ref',
      ref,
      at,
      message: `task reference ${JSON.stringify(ref)} resolves to no task in graph.tasks`,
    });
    return false;
  };

  capsule.graph.dependencies.forEach((edge, i) => {
    requireTask(edge.from, `graph.dependencies[${i}].from`);
    requireTask(edge.to, `graph.dependencies[${i}].to`);
  });

  capsule.graph.joins.forEach((join, i) => {
    join.waitsFor.forEach((ref, j) => requireTask(ref, `graph.joins[${i}].waitsFor[${j}]`));
  });

  for (const cycle of findDependencyCycles(taskIds, capsule.graph.dependencies)) {
    violations.push({
      kind: 'cyclic-dependency',
      ref: cycle[0] ?? '',
      at: 'graph.dependencies',
      message: `dependency cycle ${cycle.join(' then ')} — the graph cannot be scheduled`,
    });
  }

  const facts: { ref: string; at: string }[] = [];
  const events: { ref: string; at: string }[] = [];
  collectConditionRefs(
    capsule.graph.completionPredicate.condition,
    'graph.completionPredicate.condition',
    facts,
    events,
  );
  const declaredFields = new Set(Object.keys(capsule.graph.completionPredicate.declares.fields));
  const declaredEvents = new Set(capsule.graph.completionPredicate.declares.events);
  for (const fact of facts) {
    if (declaredFields.has(fact.ref)) continue;
    violations.push({
      kind: 'undeclared-fact',
      ref: fact.ref,
      at: fact.at,
      message: `the predicate reads fact ${JSON.stringify(fact.ref)}, which its declares.fields omits`,
    });
  }
  for (const event of events) {
    if (declaredEvents.has(event.ref)) continue;
    violations.push({
      kind: 'undeclared-event',
      ref: event.ref,
      at: event.at,
      message: `the predicate reads event ${JSON.stringify(event.ref)}, which its declares.events omits`,
    });
  }

  for (const key of Object.keys(capsule.contracts.taskInputs)) {
    requireTask(key, `contracts.taskInputs[${JSON.stringify(key)}]`);
  }
  const declaredResults = new Set(Object.keys(capsule.contracts.taskResults));
  for (const key of declaredResults) {
    requireTask(key, `contracts.taskResults[${JSON.stringify(key)}]`);
  }
  for (const key of Object.keys(capsule.settlementContract.taskVerification ?? {})) {
    requireTask(key, `settlementContract.taskVerification[${JSON.stringify(key)}]`);
  }

  capsule.settlementContract.requiredResults.forEach((ref, i) => {
    const at = `settlementContract.requiredResults[${i}]`;
    if (!requireTask(ref, at)) return;
    if (declaredResults.has(ref)) return;
    violations.push({
      kind: 'unadjudicable-required-result',
      ref,
      at,
      message:
        `settlement requires a result from task ${JSON.stringify(ref)}, and ` +
        'contracts.taskResults declares no shape to adjudicate it against',
    });
  });

  if (opts.definition !== undefined) {
    const parsed = WorkflowDefinitionV1Schema.safeParse(opts.definition);
    if (!parsed.success) {
      violations.push({
        kind: 'unsound-kernel-definition',
        ref: capsule.identity.definitionVersion,
        at: 'identity.definitionVersion',
        message:
          'the supplied workflow definition fails the published kernel contract, so no ' +
          `step reference can be resolved against it: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
      });
    } else {
      const stepIds = new Set<string>();
      collectStepIds(parsed.data, stepIds);
      capsule.graph.tasks.forEach((task, i) => {
        if (task.stepId === undefined || stepIds.has(task.stepId)) return;
        violations.push({
          kind: 'dangling-step-ref',
          ref: task.stepId,
          at: `graph.tasks[${i}].stepId`,
          message: `step reference ${JSON.stringify(task.stepId)} names no step of the pinned definition`,
        });
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
