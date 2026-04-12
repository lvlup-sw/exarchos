/**
 * Terminal phases shared across workflow types.
 *
 * A workflow in a terminal phase is complete — no further transitions are
 * expected — and is excluded from pipeline views, pruning candidates, and
 * session-start context assembly. Every built-in workflow type ends in one
 * of these phases via the universal cancel transition or its
 * type-specific completion guard.
 *
 * This constant is the single source of truth; consumers MUST import from
 * here rather than redeclare the tuple locally. Adding a new terminal phase
 * requires updating every phase schema in `schemas.ts` AND this constant in
 * lockstep.
 */
export const TERMINAL_PHASES = ['completed', 'cancelled'] as const;

export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

/** True when `phase` is a terminal phase (completed or cancelled). */
export function isTerminalPhase(phase: string): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}
