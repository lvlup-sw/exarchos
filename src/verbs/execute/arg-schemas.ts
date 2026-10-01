/**
 * Typed argument schemas, one for each compilable intent.
 * An intent can run only when it has a row in this table. The schema turns caller text into
 * the typed values for the `<var>` placeholders of the runbook. It refuses an unknown key
 * before any effect. A new intent needs a row here and its runbook, not a compiler change.
 * No schema declares `featureId`, because the compiler writes the subject identity last.
 */

import { z } from 'zod';

import { CapsuleBaseRefSchema } from '../../contract/capsule/exarchos-capsule.js';

/**
 * Arguments for `task-completion`: four per-task gates, then `task_complete`.
 * `riskTier` and `boundaryTouching` come from the caller, because no durable per-task stamp
 * holds them. Both are required, because the gate steps bind them as `<var>` placeholders,
 * and the compiler refuses an unbound placeholder. The enum matches the gate registrations.
 */
export const TaskCompletionArgs = z
  .object({
    taskId: z.string().min(1),
    worktreePath: z.string().min(1),
    branch: z.string().min(1).optional(),
    riskTier: z.enum(['low', 'medium', 'high']),
    boundaryTouching: z.boolean(),
    /**
     * The branch that the task forked from, frozen in the capsule. The key is `baseRef`, not `baseBranch`.
     * The compiler gives an argument to each leaf whose schema declares that key. Only the kill-probe step binds it,
     * as `baseBranch: '<baseRef>'`, so the other gates keep their own base.
     */
    baseRef: CapsuleBaseRefSchema,
    /** The completion provenance. Only the `task_complete` leaf declares `result`, so it alone gets this value. */
    result: z.record(z.string(), z.unknown()).optional(),
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

/**
 * Arguments for `synthesis-closeout`: validate the PR body, then open the PR.
 * `prBody` binds to the `body` parameter of both leaves, so they cannot get different texts.
 * `create_pr` can append an `## Intent` section from a captured intent. The body leaf gets
 * `body`, not `pr`, so it does not read the body back from the remote. `title`, `baseBranch`
 * and `headBranch` are required, because the `create_pr` schema requires them.
 *
 * Preconditions: the phase must admit the leaves, and the stream must not own a PR yet. After
 * a committed receipt, the caller must patch `artifacts.pr` or `synthesis.prUrl` from the
 * receipt URL. The projection does not set them, and the workflow cannot leave synthesize
 * without them.
 */
export const SynthesisCloseoutArgs = z
  .object({
    title: z.string().min(1),
    prBody: z.string().min(1),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
  })
  .strict();

/** Intent id → the schema its `args` must satisfy. */
export type IntentArgSchemas = Readonly<Record<string, z.ZodObject<z.ZodRawShape>>>;

export const INTENT_ARG_SCHEMAS: IntentArgSchemas = {
  'task-completion': TaskCompletionArgs,
  'quality-evaluation': QualityEvaluationArgs,
  'synthesis-closeout': SynthesisCloseoutArgs,
  'plan-closeout': PlanClosureArgs,
};
