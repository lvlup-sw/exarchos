/**
 * The terminal phases of every workflow type.
 *
 * A workflow in a terminal phase is complete. Pipeline views and pruning ignore it.
 * Consumers must import this tuple and not declare a local copy.
 * A new terminal phase needs a change to every phase schema in `schemas.ts` and to this tuple.
 */
export const TERMINAL_PHASES = ['completed', 'cancelled'] as const;

export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

/** True when `phase` is a terminal phase (completed or cancelled). */
export function isTerminalPhase(phase: string): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}
