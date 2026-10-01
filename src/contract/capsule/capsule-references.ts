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

/**
 * Resolve every reference in a structurally valid capsule. It returns all violations, not only the
 * first. The function does not change the document and does no I/O.
 */
export function resolveCapsuleReferences(
  capsule: ExarchosCapsuleV1,
  opts: ResolveCapsuleReferencesOptions = {},
): CapsuleReferenceVerdict {
  const violations: CapsuleReferenceViolation[] = [];

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
