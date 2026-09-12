// RESERVED(issue: #1856, owner: exarchos, expires: 2026-12-31) — the integrity
// pass ships with the contract it checks, and both land ahead of `settle`,
// their only production consumer. Delete this header when `settle` imports the
// resolver; delete the module if `settle` is abandoned.
//
// ─── The Exarchos workflow capsule — reference integrity ─────────────────────
//
// The schema (`exarchos-capsule.ts`) proves a capsule is CLOSED. This module
// proves it is RESOLVABLE. The split is forced rather than stylistic: the
// round-trip guard compares the schema against its own JSON Schema projection,
// and cross-object resolution cannot be expressed in JSON Schema at all. A rule
// added to the schema instead of to this pass would make the two validators
// disagree — which is exactly how the published kernel's own graph rules behave
// when they are projected. The admission contract in this tree splits the same
// problem the same way (`../ir/references.ts`).
//
// Five reference classes are resolved:
//
//   • TASK refs    (`graph.dependencies[].from`/`.to`, `graph.joins[].waitsFor`,
//                    the keys of `contracts.taskInputs`/`taskResults`, and
//                    `settlementContract.requiredResults`) → a task DEFINED in
//                    `graph.tasks`.
//   • ORDER        (`graph.dependencies`)                  → acyclic, so the
//                    graph can actually be scheduled.
//   • FACT/EVENT   (`graph.completionPredicate.condition`) → a name DECLARED in
//                    the predicate's own `declares` block.
//   • SETTLEMENT   (`settlementContract.requiredResults`)  → a task that
//                    declares a result shape, since settlement adjudicates a
//                    claim against that shape and cannot adjudicate against
//                    nothing.
//   • STEP refs    (`graph.tasks[].stepId`)                → a step of the
//                    kernel definition this capsule compiled from, when a
//                    caller supplies one.
//
// The kernel definition is checked by DELEGATION: `WorkflowDefinitionV1Schema
// .safeParse` runs the package's own reference rules, so the kernel's graph
// integrity is never reimplemented here — only consumed. That is the same rule
// the schema follows for `authority`.
//
// Duplicate task or join ids are violations in their own right: an ambiguous
// target cannot be soundly resolved, so a later pass would silently pick one.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import type { IrEdgeConditionNode } from '../ir/admission-ir.js';
import type { ExarchosCapsuleV1 } from './exarchos-capsule.js';
import { visitDeclaredObjects } from './kernel-derivation.js';

/**
 * Every kind of reference-integrity violation this pass can report.
 *
 * A runtime roster rather than a bare type union, and the type is derived from
 * it. `tests/unit` is typechecked by nothing, so a compile-time totality
 * assertion sited there would pass by never running; a roster the tests iterate
 * turns a new kind with no fixture into a red test instead. Carried as a schema
 * because a verdict crossing the tool boundary has to be validated there too.
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
  /** The offending reference / id value. */
  readonly ref: string;
  /** A JSON-ish path locating where the offending reference lives. */
  readonly at: string;
  readonly message: string;
}

/** The verdict from resolving every reference in a capsule. */
export interface CapsuleReferenceVerdict {
  /** `true` iff there are zero violations — the capsule is referentially sound. */
  readonly ok: boolean;
  readonly violations: readonly CapsuleReferenceViolation[];
}

/** Options for {@link resolveCapsuleReferences}. */
export interface ResolveCapsuleReferencesOptions {
  /**
   * The workflow definition this capsule compiled from, when the caller has it.
   *
   * A capsule pins a definition by DIGEST, not by value, so the definition is
   * not in the document and step references cannot be resolved without it.
   * Supplied here, it is parsed through the kernel's own schema — which is
   * where the kernel's graph rules live — before any step id is resolved
   * against it.
   */
  readonly definition?: unknown;
}

/**
 * The keys under which the kernel declares a collection of STEPS.
 *
 * The kernel nests steps in more than one place — a loop's body, a branch
 * path, a fork path, a failure handler — so the set has to be reachable at any
 * depth. But it is a SET, not "any object carrying a stepId": a transition's
 * `fromStepId`/`toStepId` are different keys and are never collected, so a
 * transition cannot make a dangling id look resolvable.
 */
const STEP_COLLECTION_KEYS: ReadonlySet<string> = new Set(['steps', 'bodySteps']);

/**
 * Every step id DECLARED by a kernel definition, at any nesting.
 *
 * The walk follows the kernel's own schema, not the document. That distinction
 * is load-bearing: `WorkflowDefinitionV1Schema` is built on `z.looseObject`, so
 * a definition the kernel accepts may retain arbitrary unknown objects, and a
 * key-name match alone would still reach inside them. A definition carrying
 * `{ notes: { steps: [{ stepId: 'step-ghost' }] } }` would then resolve a
 * capsule task that names no declared step at all — a dangling reference
 * reported as sound.
 */
function collectStepIds(definition: unknown, into: Set<string>): void {
  visitDeclaredObjects(WorkflowDefinitionV1Schema, definition, (object, key) => {
    if (key === undefined || !STEP_COLLECTION_KEYS.has(key)) return;
    const stepId = object.get('stepId');
    if (typeof stepId === 'string' && stepId.length > 0) into.add(stepId);
  });
}

/** Every fact field and event identity a condition names, with its own path. */
function collectConditionRefs(
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
      // The AST is a closed seven-kind union. A kind added to it without an arm
      // here would silently contribute no references, so this pass would report
      // a predicate as fully declared while never having read part of it —
      // which is worse than a missing check, because it reads as a clean
      // verdict. The assignment narrows to `never` today, so an eighth kind is
      // a compile error rather than a quiet hole.
      const unhandled: never = node;
      throw new Error(`capsule-references: unhandled condition kind ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Every dependency cycle, as the id sequence that closes it.
 *
 * Iterative rather than recursive so a pathological capsule cannot overflow the
 * stack. Edges to unknown tasks are skipped: a dangling endpoint is already
 * reported as its own violation and must not also read as a break in the order.
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
        // One loop, one report: the same cycle is reachable from every member,
        // and a caller reading nine rotations of it learns nothing extra. Ids
        // cannot contain a comma, so the sorted member list is a sound key.
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
 * Resolve every reference in a STRUCTURALLY-VALID capsule.
 *
 * Returns all violations — it never short-circuits — so one pass reports every
 * dangling reference rather than the first. Purely functional: no document
 * mutation and no I/O.
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
