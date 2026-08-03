// ─── P07-04 / Transition task 036 — custom-workflow reference validation ─────
//
// A custom workflow (`exarchos.config.ts`, `config.workflows[name]`) is a small
// graph: a set of named `phases`, an `initialPhase`, and `transitions` whose
// `from` / `to` name phases and whose optional `guard` names a locally-declared
// guard. It may `extends` a parent workflow type. Every one of those names is a
// REFERENCE, and a reference that points at nothing — a typo'd phase, a guard
// that was never declared, a parent that does not exist — is a latent bug that
// `registerCustomWorkflows` does NOT catch today: it wires the definition up and
// the dangling edge only surfaces at run time (or never).
//
// This module closes that gap with a PURE, TOTAL structural validator. It walks
// each workflow definition, resolves every reference against the phases/guards
// in scope (its own, plus any inherited from a resolvable parent), and emits an
// actionable {@link WorkflowReferenceDiagnostic} for each dangling reference —
// each one NAMING the offending reference and WHERE it came from (the workflow
// name and the exact field path, e.g. `transitions[2].to`). The diagnostics are
// returned in a deterministic order so the report is stable across runs.
//
// Pure: no I/O, no clock, no config reads. The parent-phase directory is passed
// in explicitly (built-in parents), sibling parents are resolved from the very
// set under validation — the validator never reaches out to a registry.

import type {
  TransitionDefinition,
  WorkflowDefinition,
} from '../../config/define.js';

/** The five built-in workflow types a custom workflow may `extends`. */
export const BUILT_IN_WORKFLOW_TYPE_NAMES: readonly string[] = Object.freeze([
  'feature',
  'debug',
  'refactor',
  'oneshot',
  'discovery',
]);

/** The kind of reference that failed to resolve. */
export type WorkflowReferenceDiagnosticCode =
  /** `initialPhase` names a phase absent from the effective phase set. */
  | 'DANGLING_INITIAL_PHASE'
  /** A transition `from` names a phase absent from the effective phase set. */
  | 'DANGLING_TRANSITION_FROM'
  /** A transition `to` names a phase absent from the effective phase set. */
  | 'DANGLING_TRANSITION_TO'
  /** A transition `guard` names a guard absent from the workflow's `guards`. */
  | 'DANGLING_GUARD'
  /** `extends` names a parent that is neither built-in nor a sibling workflow. */
  | 'DANGLING_EXTENDS'
  /** A workflow declares the same phase name twice. */
  | 'DUPLICATE_PHASE'
  /** A workflow declares no phases at all — nothing can reference into it. */
  | 'EMPTY_PHASES';

/**
 * One dangling reference. `workflow` and `location` answer WHERE the bad
 * reference came from; `reference` is the offending name itself; `message` is a
 * human-actionable sentence naming both.
 */
export interface WorkflowReferenceDiagnostic {
  readonly code: WorkflowReferenceDiagnosticCode;
  /** The workflow the dangling reference lives in (its config key). */
  readonly workflow: string;
  /** The offending reference value (the phase / guard / parent name). */
  readonly reference: string;
  /** The field path within the workflow, e.g. `transitions[2].to`. */
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
   * Parent workflow type names a custom workflow may `extends`. Defaults to the
   * five {@link BUILT_IN_WORKFLOW_TYPE_NAMES}. Names present in the config under
   * validation are always resolvable regardless of this list (sibling parents).
   */
  readonly knownWorkflowTypes?: readonly string[];
  /**
   * Phase sets for KNOWN (built-in / external) parents, so a transition that
   * references an inherited phase resolves instead of dangling. Sibling parents
   * contribute their own declared phases automatically. Omitting a parent's
   * phases here means "phases unknown" — inherited-phase references against that
   * parent are NOT flagged (fail-open on that one axis, to avoid false
   * positives about phases we cannot see).
   */
  readonly knownWorkflowPhases?: Readonly<Record<string, readonly string[]>>;
}

// ─── Effective-phase resolution ──────────────────────────────────────────────

interface EffectivePhases {
  /** The phase names in scope for reference resolution. */
  readonly names: ReadonlySet<string>;
  /**
   * `true` when the full inherited phase set is KNOWN. `false` when the
   * workflow extends a parent whose phases we cannot see — in which case a
   * `from`/`to` miss is suppressed (we cannot prove it dangling).
   */
  readonly complete: boolean;
}

/**
 * Resolve the phase names in scope for `name`, following `extends` through
 * sibling workflows (in `config`) and known built-in phase sets. Cycles in the
 * `extends` chain terminate (each name is visited at most once); an unknown
 * parent marks the set incomplete so downstream reference checks fail-open on
 * the inherited axis.
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
        // Cyclic extends — stop before looping. Whether the cycle itself is a
        // defect is out of this validator's scope; here we only avoid infinite
        // recursion and mark the inherited set incomplete.
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
        // A real parent type whose phase set we cannot see: inherited phases
        // are genuinely unknown, so suppress `from`/`to` dangling checks.
        complete = false;
      }
      // else: the parent does not exist at all (a dangling `extends`, reported
      // separately). It contributes no phases and does NOT make the set
      // incomplete — `from`/`to` are still checked against the OWN phases.
    }
  }

  return { names, complete };
}

// ─── Per-workflow reference checks ───────────────────────────────────────────

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

function checkWorkflow(
  workflow: string,
  def: WorkflowDefinition,
  config: Readonly<Record<string, WorkflowDefinition>>,
  knownTypes: ReadonlySet<string>,
  knownWorkflowPhases: Readonly<Record<string, readonly string[]>>,
  out: WorkflowReferenceDiagnostic[],
): void {
  // Duplicate / empty phase declarations.
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

  // `extends` must resolve to a built-in type, an external known type, or a
  // sibling workflow under validation.
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

  // `initialPhase` must be one of the workflow's OWN declared phases (an
  // initial phase is where THIS workflow starts, not an inherited one).
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
 * Validate every reference in a custom-workflow set. Returns a stable,
 * deterministically-ordered list of dangling-reference diagnostics; `ok` is
 * `true` iff the list is empty.
 *
 * Total and pure: any input map produces a report, and the same input always
 * produces the same report.
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
