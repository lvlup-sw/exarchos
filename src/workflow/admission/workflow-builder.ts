// ─── P07-03 / Transition tasks 033, 034 — Builder combinators + lowering ─────
//
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// authoring API awaiting the legacy HSM cutover, same staging as
// `built-in-workflow-ir.ts`'s consumers. The builder is the ERGONOMIC surface a
// workflow author uses to declare edges; nothing produces workflow IR through
// it in production until P07-05 removes the legacy guard path and the built-in
// definitions are re-expressed through this API. What is true NOW is that the
// builder lowers to EXACTLY the shared IR (`built-in-workflow-ir.ts`) shapes the
// translation already consumes, and that the closure property survives it.
//
// ## What this is
//
// A small, typed set of combinators that build up the closed P06-02
// edge-condition AST and the P07-02 admission obligations, then LOWER them to
// the shared {@link WorkflowEdgeIR} that `legacy-state-translation.ts` and
// `adjudicateEdge` already accept. The builder is a *thin, honest* authoring
// layer: it does not invent a second condition language, it composes the SAME
// seven closed nodes and lowers through the SAME `compileEdgeCondition`
// validator.
//
// ## The closure property survives the builder (the load-bearing invariant)
//
// It is IMPOSSIBLE to author an escape hatch through this API:
//
//   1. Type level — the combinators only accept a {@link ConditionSpec} (for
//      connectives / obligations) or a primitive `string` / `number` /
//      `boolean` / {@link EdgeCompareOp} (for leaves). There is NO combinator
//      that accepts a raw AST node, a `string` expression, a closure, or an
//      arbitrary predicate. `ConditionSpec` is a PHANTOM-branded type whose
//      brand symbol is not exported, so the only way to obtain one is to call a
//      combinator — a raw object literal is not assignable to it.
//   2. Runtime level — every lowering (`lowerCondition`, `lowerObligation`,
//      `buildEdge`) routes through {@link compileEdgeCondition}, which rejects
//      unknown node kinds, unknown properties (the string-expression escape
//      hatch), executable values, and prototype pollution AT COMPILE TIME. So
//      even a caller who defeats the type system with a double cast
//      (`x as unknown as ConditionSpec`) has their escape hatch rejected the
//      moment it is lowered — the branded type is a convenience, the compiler is
//      the guarantee.
//
// Pure: no I/O, no clock, no config reads. The builder is a total function of
// its inputs and the (data-only) fact declaration.

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

// ─── Branded authoring specs ────────────────────────────────────────────────
//
// A `ConditionSpec` / `ObligationSpec` is, at runtime, exactly the plain,
// inert node/obligation object the combinators assemble. The brand exists ONLY
// in the type system: it makes the spec unconstructable outside this module's
// combinators (the brand symbol is never exported), so a raw object literal — a
// would-be escape hatch — is not assignable where a spec is required.

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

// ─── Leaf combinators ───────────────────────────────────────────────────────

/**
 * An observed-event identity test. Absence is a definite `false`. Accepts only
 * the event name — never a closure or expression.
 */
export function event(name: string): ConditionSpec {
  return toConditionSpec({ kind: 'eventObserved', event: name });
}

/** Tests whether a projected fact field is present. Absence is a definite `false`. */
export function present(field: string): ConditionSpec {
  return toConditionSpec({ kind: 'factPresent', field });
}

/**
 * Tests whether a present fact equals a declared scalar. The value is
 * constrained to {@link FactScalar} (`string | number | boolean`) — a function
 * or object is a type error, so no executable escape hatch can be smuggled in.
 */
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

// ─── Connectives ────────────────────────────────────────────────────────────

/**
 * Conjunction. Empty operands is the always-legal constant (`true`). Operands
 * must themselves be {@link ConditionSpec}s, so the tree stays closed — there is
 * no leaf a raw predicate could occupy.
 */
export function all(...operands: readonly ConditionSpec[]): ConditionSpec {
  return toConditionSpec({ kind: 'all', operands: operands.map(nodeOf) });
}

/** Disjunction. Empty operands is the never-legal constant (`false`). */
export function any(...operands: readonly ConditionSpec[]): ConditionSpec {
  return toConditionSpec({ kind: 'any', operands: operands.map(nodeOf) });
}

/** Negation of a closed condition. */
export function not(operand: ConditionSpec): ConditionSpec {
  return toConditionSpec({ kind: 'not', operand: nodeOf(operand) });
}

/** The always-legal route (structural `true`; an empty conjunction). */
export function always(): ConditionSpec {
  return all();
}

/** The never-legal route (structural `false`; an empty disjunction). */
export function never(): ConditionSpec {
  return any();
}

// ─── Obligation combinators ─────────────────────────────────────────────────

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

/**
 * A gate-evidence obligation. `presence` is a closed condition deciding whether
 * the certifying fact is genuinely present in projected state.
 */
export function gate(gateId: string, presence: ConditionSpec): ObligationSpec {
  return toObligationSpec({ kind: 'gate', gateId, presence: nodeOf(presence) });
}

/**
 * A typed approval obligation. `presence` decides whether the approval signal
 * is present; `minimumApprovals` defaults to one.
 */
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

// ─── Edge authoring spec ────────────────────────────────────────────────────

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

// ─── Lowering to shared IR ──────────────────────────────────────────────────

/**
 * Lower a condition spec to a validated {@link CompiledEdgeCondition} against a
 * fact declaration (defaults to the shared {@link FACT_DECLARATION} every
 * built-in route and presence probe is declared over). This is the runtime
 * closure-enforcement point: {@link compileEdgeCondition} rejects any escape
 * hatch that defeated the type system.
 */
export function lowerCondition(
  spec: ConditionSpec,
  declaration: EdgeConditionDeclaration = FACT_DECLARATION,
): CompiledEdgeCondition {
  return compileEdgeCondition(nodeOf(spec), declaration);
}

/**
 * Lower an obligation spec to the shared {@link EdgeObligation}, compiling its
 * presence probe. A `none` obligation lowers to `{ kind: 'none' }`.
 */
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
 * Build one shared-IR {@link WorkflowEdgeIR} from an authoring spec. The
 * resulting edge is byte-for-byte the same shape `built-in-workflow-ir.ts`
 * produces by hand, so `adjudicateEdge` / `translateEdgeAdmission` accept it
 * unchanged.
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
