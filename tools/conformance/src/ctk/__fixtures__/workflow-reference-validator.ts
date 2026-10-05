// Custom-workflow reference validation. A custom workflow names phases, an `initialPhase`, and
// transitions with `from`, `to` and an optional `guard`. It can also name an `extends` parent.
// This pure, total validator resolves each name against the phases and guards in scope, which
// include the phases of a resolvable parent. Each diagnostic names the dangling reference, the
// workflow and the field path, for example `transitions[2].to`.
//
// The order of the diagnostics is deterministic. The caller passes the phases of known parents.
// A sibling parent resolves from the set under validation, with no registry read.

import type {
  TransitionDefinition,
  WorkflowDefinition,
} from '../../../../../src/config/define.js';

/** The five built-in workflow types that a custom workflow can extend. */
export const BUILT_IN_WORKFLOW_TYPE_NAMES: readonly string[] = Object.freeze([
  'feature',
  'debug',
  'refactor',
  'oneshot',
  'discovery',
]);

/**
 * The kind of reference that failed to resolve. A `DANGLING_*` code names a reference with no
 * target in scope. `DUPLICATE_PHASE` and `EMPTY_PHASES` report a fault in the phase list itself.
 */
export type WorkflowReferenceDiagnosticCode =
  | 'DANGLING_INITIAL_PHASE'
  | 'DANGLING_TRANSITION_FROM'
  | 'DANGLING_TRANSITION_TO'
  | 'DANGLING_GUARD'
  | 'DANGLING_EXTENDS'
  | 'DUPLICATE_PHASE'
  | 'EMPTY_PHASES';

/**
 * One dangling reference. `workflow` and `location` tell where the reference came from.
 * `reference` is the name that does not resolve, and `message` names both.
 */
export interface WorkflowReferenceDiagnostic {
  readonly code: WorkflowReferenceDiagnosticCode;
  /** The workflow the dangling reference lives in (its config key). */
  readonly workflow: string;
  /** The offending reference value (the phase / guard / parent name). */
  readonly reference: string;
  /** The field path within the workflow, for example `transitions[2].to`. */
  readonly location: string;
  /** Actionable diagnostic naming the reference and its origin. */
  readonly message: string;
}

export interface WorkflowReferenceReport {
  readonly ok: boolean;
  readonly diagnostics: readonly WorkflowReferenceDiagnostic[];
}

export interface ValidateWorkflowReferencesOptions {
  /**
   * The parent workflow types that a custom workflow can extend. The default is
   * {@link BUILT_IN_WORKFLOW_TYPE_NAMES}. A sibling workflow in the config always resolves.
   */
  readonly knownWorkflowTypes?: readonly string[];
  /**
   * The phase sets of known parents, so a reference to an inherited phase resolves. A sibling
   * parent contributes its own phases. If a known parent has no entry here, its phases are
   * unknown, and the check flags no `from` or `to` miss. This fail-open prevents false positives.
   */
  readonly knownWorkflowPhases?: Readonly<Record<string, readonly string[]>>;
}

interface EffectivePhases {
  /** The phase names in scope for reference resolution. */
  readonly names: ReadonlySet<string>;
  /**
   * `true` when the full inherited phase set is known. `false` when a parent has unknown phases or
   * the `extends` chain has a cycle. Then the check suppresses a `from` or `to` miss.
   */
  readonly complete: boolean;
}

/**
 * Resolves the phase names in scope for `name`. It follows `extends` through sibling workflows and
 * the known parent phase sets. A cycle stops the walk and marks the set incomplete, but this
 * validator does not report a cycle. A known parent with unknown phases also marks the set
 * incomplete. A parent that does not exist adds no phases and keeps the set complete. Then the
 * check still compares `from` and `to` with the phases that the workflow itself declares.
 */
function resolveEffectivePhases(
  name: string,
  config: Readonly<Record<string, WorkflowDefinition>>,
  knownTypes: ReadonlySet<string>,
  knownWorkflowPhases: Readonly<Record<string, readonly string[]>>,
  visiting: ReadonlySet<string>,
): EffectivePhases {
  const names = new Set<string>();
  let complete = true;

  const def = config[name];
  if (def !== undefined) {
    for (const phase of def.phases) names.add(phase);

    const parent = def.extends;
    if (parent !== undefined) {
      if (visiting.has(parent)) {
        complete = false;
      } else if (Object.prototype.hasOwnProperty.call(config, parent)) {
        const inherited = resolveEffectivePhases(
          parent,
          config,
          knownTypes,
          knownWorkflowPhases,
          new Set([...visiting, name]),
        );
        for (const phase of inherited.names) names.add(phase);
        complete = complete && inherited.complete;
      } else if (Object.prototype.hasOwnProperty.call(knownWorkflowPhases, parent)) {
        for (const phase of knownWorkflowPhases[parent] ?? []) names.add(phase);
      } else if (knownTypes.has(parent)) {
        complete = false;
      }
    }
  }

  return { names, complete };
}

function checkTransition(
  workflow: string,
  transition: TransitionDefinition,
  index: number,
  effective: EffectivePhases,
  guardKeys: ReadonlySet<string>,
  out: WorkflowReferenceDiagnostic[],
): void {
  if (effective.complete && !effective.names.has(transition.from)) {
    out.push({
      code: 'DANGLING_TRANSITION_FROM',
      workflow,
      reference: transition.from,
      location: `transitions[${index}].from`,
      message:
        `Workflow '${workflow}' transition ${index} references source phase ` +
        `'${transition.from}', which is not a declared phase of '${workflow}'.`,
    });
  }
  if (effective.complete && !effective.names.has(transition.to)) {
    out.push({
      code: 'DANGLING_TRANSITION_TO',
      workflow,
      reference: transition.to,
      location: `transitions[${index}].to`,
      message:
        `Workflow '${workflow}' transition ${index} references target phase ` +
        `'${transition.to}', which is not a declared phase of '${workflow}'.`,
    });
  }
  if (transition.guard !== undefined && !guardKeys.has(transition.guard)) {
    out.push({
      code: 'DANGLING_GUARD',
      workflow,
      reference: transition.guard,
      location: `transitions[${index}].guard`,
      message:
        `Workflow '${workflow}' transition ${index} references guard ` +
        `'${transition.guard}', which is not declared in '${workflow}'.guards.`,
    });
  }
}

/**
 * Checks one workflow. `extends` must name a known type or a sibling workflow. `initialPhase` must
 * be a phase that the workflow itself declares, not an inherited phase.
 */
function checkWorkflow(
  workflow: string,
  def: WorkflowDefinition,
  config: Readonly<Record<string, WorkflowDefinition>>,
  knownTypes: ReadonlySet<string>,
  knownWorkflowPhases: Readonly<Record<string, readonly string[]>>,
  out: WorkflowReferenceDiagnostic[],
): void {
  const seenPhases = new Set<string>();
  for (const phase of def.phases) {
    if (seenPhases.has(phase)) {
      out.push({
        code: 'DUPLICATE_PHASE',
        workflow,
        reference: phase,
        location: 'phases',
        message:
          `Workflow '${workflow}' declares phase '${phase}' more than once; ` +
          `phase names must be unique.`,
      });
    }
    seenPhases.add(phase);
  }
  if (def.phases.length === 0) {
    out.push({
      code: 'EMPTY_PHASES',
      workflow,
      reference: workflow,
      location: 'phases',
      message: `Workflow '${workflow}' declares no phases; it can carry no transitions.`,
    });
  }

  if (def.extends !== undefined) {
    const isSibling = Object.prototype.hasOwnProperty.call(config, def.extends);
    if (!isSibling && !knownTypes.has(def.extends)) {
      out.push({
        code: 'DANGLING_EXTENDS',
        workflow,
        reference: def.extends,
        location: 'extends',
        message:
          `Workflow '${workflow}' extends '${def.extends}', which is neither a ` +
          `built-in workflow type nor another workflow in this config.`,
      });
    }
  }

  const effective = resolveEffectivePhases(
    workflow,
    config,
    knownTypes,
    knownWorkflowPhases,
    new Set<string>(),
  );

  if (!seenPhases.has(def.initialPhase)) {
    out.push({
      code: 'DANGLING_INITIAL_PHASE',
      workflow,
      reference: def.initialPhase,
      location: 'initialPhase',
      message:
        `Workflow '${workflow}' declares initialPhase '${def.initialPhase}', ` +
        `which is not one of its declared phases.`,
    });
  }

  const guardKeys = new Set<string>(Object.keys(def.guards ?? {}));
  def.transitions.forEach((transition, index) => {
    checkTransition(workflow, transition, index, effective, guardKeys, out);
  });
}

const DIAGNOSTIC_ORDER: readonly WorkflowReferenceDiagnosticCode[] = [
  'EMPTY_PHASES',
  'DUPLICATE_PHASE',
  'DANGLING_EXTENDS',
  'DANGLING_INITIAL_PHASE',
  'DANGLING_TRANSITION_FROM',
  'DANGLING_TRANSITION_TO',
  'DANGLING_GUARD',
];

function diagnosticSortKey(d: WorkflowReferenceDiagnostic): string {
  const codeRank = DIAGNOSTIC_ORDER.indexOf(d.code).toString().padStart(2, '0');
  return `${d.workflow}\u0000${codeRank}\u0000${d.location}\u0000${d.reference}`;
}

/**
 * Validates every reference in a custom-workflow set. Pure and total: the same input always gives
 * the same report, in a deterministic order. `ok` is `true` only when the list is empty.
 */
export function validateWorkflowReferences(
  workflows: Readonly<Record<string, WorkflowDefinition>>,
  options: ValidateWorkflowReferencesOptions = {},
): WorkflowReferenceReport {
  const knownTypes = new Set<string>(
    options.knownWorkflowTypes ?? BUILT_IN_WORKFLOW_TYPE_NAMES,
  );
  const knownWorkflowPhases = options.knownWorkflowPhases ?? {};

  const diagnostics: WorkflowReferenceDiagnostic[] = [];
  for (const [workflow, def] of Object.entries(workflows)) {
    checkWorkflow(
      workflow,
      def,
      workflows,
      knownTypes,
      knownWorkflowPhases,
      diagnostics,
    );
  }

  diagnostics.sort((a, b) => {
    const ka = diagnosticSortKey(a);
    const kb = diagnosticSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { ok: diagnostics.length === 0, diagnostics };
}
