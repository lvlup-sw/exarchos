// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// authoring API that waits for the legacy HSM cutover. No production code builds
// workflow IR through it yet. The built-in definitions move to it when the legacy
// guard path goes away.
//
// The combinators build the closed edge-condition AST and the admission obligations.
// Then they lower them to the shared {@link WorkflowEdgeIR} from `built-in-workflow-ir.ts`,
// which `legacy-state-translation.ts` and `adjudicateEdge` accept.
//
// No caller can author an escape hatch. A spec carries a brand that this module does not
// export, so only a combinator makes one. Every lowering goes through {@link compileEdgeCondition}.
// It rejects unknown nodes, unknown properties, executable values and prototype pollution,
// so a double cast also fails. The builder is pure: no I/O, no clock, no configuration reads.

import {
  compileEdgeCondition,
  type CompiledEdgeCondition,
  type EdgeCompareOp,
  type EdgeConditionDeclaration,
  type FactScalar,
} from './edge-condition.js';
import {
  FACT_DECLARATION,
  type BuiltInWorkflowType,
  type EdgeCategory,
  type EdgeObligation,
  type WorkflowEdgeIR,
} from './built-in-workflow-ir.js';
import type { PhaseKind } from '../phase-kind.js';

/**
 * The brand of a `ConditionSpec`. It exists only in the type system.
 * At runtime a spec is the plain node object that a combinator assembles.
 */
declare const conditionSpecBrand: unique symbol;

/** An opaque, closed edge-condition authored through the combinators. */
export interface ConditionSpec {
  readonly [conditionSpecBrand]: 'ConditionSpec';
}

declare const obligationSpecBrand: unique symbol;

/** An opaque admission obligation authored through the combinators. */
export interface ObligationSpec {
  readonly [obligationSpecBrand]: 'ObligationSpec';
}

/** Mint a spec from an assembled node. The cast is contained to this module. */
function toConditionSpec(node: Record<string, unknown>): ConditionSpec {
  return node as unknown as ConditionSpec;
}

/** Recover the inert node object a spec wraps (runtime identity). */
function nodeOf(spec: ConditionSpec): unknown {
  return spec as unknown;
}

/** Tests whether an event with this name occurred. Absence is a definite `false`. */
export function event(name: string): ConditionSpec {
  return toConditionSpec({ kind: 'eventObserved', event: name });
}

/** Tests whether a projected fact field is present. Absence is a definite `false`. */
export function present(field: string): ConditionSpec {
  return toConditionSpec({ kind: 'factPresent', field });
}

/** Tests whether a present fact equals a scalar. A function or an object value is a type error. */
export function equals(field: string, value: FactScalar): ConditionSpec {
  return toConditionSpec({ kind: 'factEquals', field, value });
}

/** Compares a present numeric counter fact against a declared threshold. */
export function compare(
  field: string,
  op: EdgeCompareOp,
  value: number,
): ConditionSpec {
  return toConditionSpec({ kind: 'counterCompare', field, op, value });
}

/** Conjunction. With no operands, it is the always-legal constant (`true`). */
export function all(...operands: readonly ConditionSpec[]): ConditionSpec {
  return toConditionSpec({ kind: 'all', operands: operands.map(nodeOf) });
}

/** Disjunction. With no operands, it is the never-legal constant (`false`). */
export function any(...operands: readonly ConditionSpec[]): ConditionSpec {
  return toConditionSpec({ kind: 'any', operands: operands.map(nodeOf) });
}

/** Negation of a closed condition. */
export function not(operand: ConditionSpec): ConditionSpec {
  return toConditionSpec({ kind: 'not', operand: nodeOf(operand) });
}

/** The always-legal route: an empty conjunction. */
export function always(): ConditionSpec {
  return all();
}

/** The never-legal route: an empty disjunction. */
export function never(): ConditionSpec {
  return any();
}

/** Mint an obligation spec from an assembled obligation object. */
function toObligationSpec(raw: Record<string, unknown>): ObligationSpec {
  return raw as unknown as ObligationSpec;
}

/** The three internal obligation shapes the combinators assemble. */
type RawObligation =
  | { readonly kind: 'none' }
  | { readonly kind: 'gate'; readonly gateId: string; readonly presence: unknown }
  | {
      readonly kind: 'approval';
      readonly approvalClass: string;
      readonly minimumApprovals: number;
      readonly presence: unknown;
    };

function rawObligationOf(spec: ObligationSpec): RawObligation {
  return spec as unknown as RawObligation;
}

/** A pure routing / bounded-loop / universal edge: no evidence obligation. */
export const noObligation: ObligationSpec = toObligationSpec({ kind: 'none' });

/** A gate-evidence obligation. `presence` decides whether the certifying fact is in the projected state. */
export function gate(gateId: string, presence: ConditionSpec): ObligationSpec {
  return toObligationSpec({ kind: 'gate', gateId, presence: nodeOf(presence) });
}

/** A typed approval obligation. `presence` decides whether the approval signal is present. */
export function approval(
  approvalClass: string,
  presence: ConditionSpec,
  minimumApprovals = 1,
): ObligationSpec {
  return toObligationSpec({
    kind: 'approval',
    approvalClass,
    minimumApprovals,
    presence: nodeOf(presence),
  });
}

/** The ergonomic authoring shape for one built-in-workflow edge. */
export interface WorkflowEdgeSpec {
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  readonly toPhaseKind: PhaseKind;
  readonly category: EdgeCategory;
  readonly legacyGuardId: string | null;
  /** Route legality. Omitted ⇒ always-legal (`always()`). */
  readonly route?: ConditionSpec;
  /** Admission obligation once the edge is routable. */
  readonly obligation: ObligationSpec;
}

/**
 * Compiles a condition spec against a fact declaration, by default the shared {@link FACT_DECLARATION}.
 * This is the runtime check: {@link compileEdgeCondition} rejects an escape hatch that got past the types.
 */
export function lowerCondition(
  spec: ConditionSpec,
  declaration: EdgeConditionDeclaration = FACT_DECLARATION,
): CompiledEdgeCondition {
  return compileEdgeCondition(nodeOf(spec), declaration);
}

/** Lowers an obligation spec to the shared {@link EdgeObligation} and compiles its presence probe. */
export function lowerObligation(
  spec: ObligationSpec,
  declaration: EdgeConditionDeclaration = FACT_DECLARATION,
): EdgeObligation {
  const raw = rawObligationOf(spec);
  switch (raw.kind) {
    case 'none': {
      const obligation: EdgeObligation = { kind: 'none' };
      return Object.freeze(obligation);
    }
    case 'gate': {
      const obligation: EdgeObligation = {
        kind: 'gate',
        gateId: raw.gateId,
        presence: compileEdgeCondition(raw.presence, declaration),
      };
      return Object.freeze(obligation);
    }
    case 'approval': {
      const obligation: EdgeObligation = {
        kind: 'approval',
        approvalClass: raw.approvalClass,
        minimumApprovals: raw.minimumApprovals,
        presence: compileEdgeCondition(raw.presence, declaration),
      };
      return Object.freeze(obligation);
    }
  }
}

/**
 * Builds one {@link WorkflowEdgeIR} from an authoring spec.
 * The edge has the same shape as a hand-written edge in `built-in-workflow-ir.ts`.
 */
export function buildEdge(
  spec: WorkflowEdgeSpec,
  declaration: EdgeConditionDeclaration = FACT_DECLARATION,
): WorkflowEdgeIR {
  const edge: WorkflowEdgeIR = {
    workflowType: spec.workflowType,
    from: spec.from,
    to: spec.to,
    toPhaseKind: spec.toPhaseKind,
    category: spec.category,
    legacyGuardId: spec.legacyGuardId,
    routeCondition: lowerCondition(spec.route ?? always(), declaration),
    obligation: lowerObligation(spec.obligation, declaration),
  };
  return Object.freeze(edge);
}

/** Build a whole edge set for a workflow, in declaration order. */
export function buildEdges(
  specs: readonly WorkflowEdgeSpec[],
  declaration: EdgeConditionDeclaration = FACT_DECLARATION,
): readonly WorkflowEdgeIR[] {
  return Object.freeze(specs.map((spec) => buildEdge(spec, declaration)));
}
