/**
 * Typed argument schemas, one for each compilable intent.
 * An intent can run only when it has a row in this table. The schema turns caller text into
 * the typed values for the `<var>` placeholders of the runbook. It refuses an unknown key
 * before any effect. A new intent needs a row here and its runbook, not a compiler change.
 * No schema declares `featureId`, because the compiler writes the subject identity last.
 */

import { z } from 'zod';

import { CapsuleBaseRefSchema, TaskVerificationCoordinateSchema } from '../../contract/capsule/exarchos-capsule.js';

/**
 * Arguments for `task-completion`: five per-task gates, then `task_complete`.
 * `riskTier` and `boundaryTouching` come from the caller, because no durable per-task stamp
 * holds them. Both are required, because four gate steps bind them as `<var>` placeholders,
 * and the compiler refuses an unbound placeholder. The enum matches the gate registrations.
 */
export const TaskCompletionArgs = z
  .object({
    taskId: z.string().min(1),
    coordinate: TaskVerificationCoordinateSchema.optional(),
    worktreePath: z.string().min(1),
    branch: z.string().min(1).optional(),
    riskTier: z.enum(['low', 'medium', 'high']),
    boundaryTouching: z.boolean(),
    /**
     * The branch that the task forked from, frozen in the capsule. The key is `baseRef`, not `baseBranch`.
     * The compiler gives an argument to each leaf whose schema declares that key.
     * Three gates bind it as `baseBranch: '<baseRef>'`: contract drift, mock boundary and the integration suite.
     * The integration suite only names it in its evidence subject. Static analysis scans the whole tree and keeps its own base label.
     */
    baseRef: CapsuleBaseRefSchema,
    /** The completion provenance. Only the `task_complete` leaf declares `result`, so it alone gets this value. */
    result: z.record(z.string(), z.unknown()).optional(),
    /** The capsule that the task compiled in. Only the `task_complete` leaf declares `capsuleVersion`, so it alone gets this value. */
    capsuleVersion: z.number().int().min(1).optional(),
  })
  .strict();

/**
 * Arguments for `quality-evaluation`, the review-phase runbook.
 * `high`, `medium` and `low` are required, because the verdict leaf schema requires them.
 * `diffContent` is required, because the security-scan handler refuses at runtime without it.
 *
 * Precondition: the invariant gate `requires` a resolved review gate, and no leaf in this
 * segment produces it. Thus the stream must already carry passing review gate evidence for
 * the active phase attempt.
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
 * Arguments for `plan-closeout`: the two blocking plan gates, then the traceability matrix.
 * The leaves name the spec path with four different parameters. One `specPath` binds to all
 * four, so the leaves cannot get different paths.
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
