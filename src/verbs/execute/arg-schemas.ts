// ─── Typed argument schemas, one per compilable intent ──────────────────────
//
// The public surface takes `args`, not a free-form `Record<string, string>`.
// An intent is executable here only if it appears in this table: the schema is
// what turns caller text into the typed values the runbook's `<var>`
// placeholders substitute, and what rejects an unknown key before any effect.
//
// One intent ships. Adding another is adding a row here plus the runbook it
// names — not a change to the compiler.

import { z } from 'zod';

/**
 * `task-completion` — the delegate-phase runbook: four per-task gates followed
 * by the terminal `task_complete`.
 *
 * `riskTier` and `boundaryTouching` are accepted from the caller because no
 * durable per-task stamp exists to read them from. The enum matches the one
 * the gate registrations declare, so a value that passes here is a value the
 * gate schemas will also accept.
 *
 * Both are REQUIRED, because every gate step in `task-completion` passes them
 * as `<var>` placeholders and the compiler refuses a placeholder it cannot
 * bind. Leaving them optional here said "omit these" to a caller reading the
 * schema and then refused the call anyway — the schema and the runbook
 * disagreed about the same fact. A runbook whose steps do not name them gets
 * its own schema; this one states what this runbook needs.
 */
export const TaskCompletionArgs = z
  .object({
    taskId: z.string().min(1),
    worktreePath: z.string().min(1),
    branch: z.string().min(1).optional(),
    riskTier: z.enum(['low', 'medium', 'high']),
    boundaryTouching: z.boolean(),
  })
  .strict();

/** Intent id → the schema its `args` must satisfy. */
export type IntentArgSchemas = Readonly<Record<string, z.ZodObject<z.ZodRawShape>>>;

export const INTENT_ARG_SCHEMAS: IntentArgSchemas = {
  'task-completion': TaskCompletionArgs,
};
