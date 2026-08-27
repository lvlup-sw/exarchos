// ─── Typed argument schemas, one per compilable intent ──────────────────────
//
// The public surface takes `args`, not a free-form `Record<string, string>`.
// An intent is executable here only if it appears in this table: the schema is
// what turns caller text into the typed values the runbook's `<var>`
// placeholders substitute, and what rejects an unknown key before any effect.
//
// Three intents ship. Adding another is adding a row here plus the runbook it
// names — not a change to the compiler.
//
// None of them declares `featureId`. Subject identity is written LAST by the
// compiler over every leaf that declares it, so an intent argument spelled the
// same way would be overwritten anyway — and a schema that accepts a field it
// cannot influence says the caller has a choice they do not have.

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

/**
 * `quality-evaluation` — the review-phase runbook: static analysis, the
 * security scan, the convergence meta-gate, invariant conformance, and the
 * terminal review verdict.
 *
 * `high`, `medium` and `low` are REQUIRED because the verdict leaf's own
 * registered schema requires them, and the compiler validates each leaf against
 * that schema before any effect. `diffContent` is required for a reason the
 * registry does not state: the security-scan handler declares the field
 * optional and then refuses at runtime without it, so accepting a call that
 * omits it would only move the refusal past the point where earlier leaves have
 * already run.
 *
 * PRECONDITION the caller owes and this schema cannot express: the invariant
 * gate declares a `requires` on a resolved review gate. Nothing in this segment
 * produces that fact — the verdict leaf's own evidence does not satisfy it —
 * so the segment runs only against a stream that already carries passing gate
 * evidence for the active phase attempt under the review requirement.
 */
export const QualityEvaluationArgs = z
  .object({
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    diffContent: z.string().min(1),
    diff: z.string().min(1).optional(),
    repoRoot: z.string().min(1).optional(),
    worktreePath: z.string().min(1).optional(),
    blockedReason: z.string().min(1).optional(),
  })
  .strict();

/**
 * `plan-closeout` — the plan-phase runbook: the two blocking plan gates over
 * the unified spec, then the traceability matrix.
 *
 * One field, because one path is the whole subject. Both gates and the matrix
 * generator address the SAME document under four different parameter
 * spellings; binding one variable onto all four is what keeps the caller from
 * being asked the same question twice and answering it differently.
 */
export const PlanClosureArgs = z
  .object({
    specPath: z.string().min(1),
  })
  .strict();

/** Intent id → the schema its `args` must satisfy. */
export type IntentArgSchemas = Readonly<Record<string, z.ZodObject<z.ZodRawShape>>>;

export const INTENT_ARG_SCHEMAS: IntentArgSchemas = {
  'task-completion': TaskCompletionArgs,
  'quality-evaluation': QualityEvaluationArgs,
  'plan-closeout': PlanClosureArgs,
};
