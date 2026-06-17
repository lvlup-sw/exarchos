// ─── Phase-Kind Obligation Layer (single grant-point) ───────────────────────
//
// A closed `PhaseKind` union and a frozen `KIND_OBLIGATIONS` table — the one
// place where kind-universal obligations are granted. The table is keyed only
// by kind, never by workflow type, phase id, or transition. This is INV-6
// (workload-agnosticism) made type-level: an obligation attaches to the *kind*,
// so it composes across every workflow type — present and future — without new
// playbook code. See `docs/designs/2026-06-16-phase-kind-binding.md` (DR-1).
//
// INV-6 GUARD: no workflow names / phase ids / transitions here — only
// kind-universal obligations. (The resolver wiring lives in later tasks.)

/**
 * The closed set of phase kinds. Adding or removing a member is a breaking
 * change that must be reflected in `KIND_OBLIGATIONS` (enforced by the
 * `satisfies Record<PhaseKind, …>` constraint below).
 */
export type PhaseKind = 'IMPLEMENT' | 'PLAN' | 'REVIEW' | 'SYNTHESIZE' | 'GATHER';

/**
 * The obligations granted to a phase by virtue of its kind.
 *
 * - `gates`  — the gate-resolver binding for this kind, or `null` when the kind
 *   carries no verification gates (e.g. GATHER). The `resolver` is a name the
 *   gate-set resolver dispatches on (wired in a later task); the kind layer
 *   itself holds no resolver logic.
 * - `posture` — the execution posture for the kind. Declared now so the table
 *   shape is stable, but **inert** in this layer: it is not yet wired to a
 *   capability bundle.
 */
export interface PhaseObligations {
  readonly gates: { readonly resolver: string } | null;
  readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating';
}

/**
 * The single grant-point: one obligation row per phase kind.
 *
 * `satisfies Record<PhaseKind, PhaseObligations>` is load-bearing — removing a
 * kind row (or adding a kind without a row) is a COMPILE error, which keeps the
 * union and the table exhaustively in lock-step.
 */
export const KIND_OBLIGATIONS = {
  IMPLEMENT: { gates: { resolver: 'verification-ladder' }, posture: 'task-isolated' },
  PLAN: { gates: { resolver: 'plan-structure' }, posture: 'read-only' },
  REVIEW: { gates: { resolver: 'review-contract' }, posture: 'read-only' },
  SYNTHESIZE: { gates: { resolver: 'synthesis-readiness' }, posture: 'shared-mutating' },
  GATHER: { gates: null, posture: 'read-only' },
} as const satisfies Record<PhaseKind, PhaseObligations>;
