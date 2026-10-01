// Registers `execute_intent`, which compiles a named intent into a segment of registered local actions.
// The action runs the segment leaf by leaf and commits one operation record on either outcome.
// The compiler and the run loop live in `verbs/execute/`.

import { coercedRecord } from '../../../coerce.js';
import { withCappedShape } from '../../../output-schema-declaration.js';
import { IntentExecutedOutputSchema } from '../../../verbs/execute/schemas.js';
import { EXECUTE_INTENT_ECONOMY_BUDGET_TOKENS, summarizeIntentReceipt } from '../../../verbs/execute/economy.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION } from '../../annotations.js';
import { DELEGATE_PHASES, PLAN_PHASES, REVIEW_PHASES, ROLE_ANY } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function withContract(
  action: BuiltinActionDraft,
  partial: {
    readonly requires?: ActionContract['requires'];
    readonly ensures: ActionContract['ensures'];
    readonly needs: ActionContract['needs'];
    readonly resources?: ActionContract['touches']['resources'];
    readonly replay: ActionContract['replay'];
    readonly emissions?: ActionContract['emissions'];
  },
): BuiltinToolAction {
  return withActionContract(
    action,
    {
      requires: partial.requires ?? none('this action does not consume a prior resolved gate or approval floor'),
      ensures: partial.ensures,
      needs: partial.needs,
      touches: {
        frame: 'single-machine',
        resources: partial.resources ?? none('this action does not address a stream, path, worktree, or git-ref'),
      },
      executionAuthority: { kind: 'local' },
      replay: partial.replay,
      emissions: partial.emissions ?? none('this action appends no catalog events'),
    },
    { annotations: action.annotations },
  );
}

export const executeActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'execute_intent',
    /** Kept within the per-action description budget. The argument schemas give the reason for each required field. */
    description:
      'Compile a NAMED intent (a runbook id) into a segment of already-registered local ' +
      'actions and run it leaf by leaf, committing one orchestrate.intent_executed record ' +
      "on either outcome. `args` is validated against that intent's own typed schema, never " +
      "an action array. Intents: 'task-completion' (delegate) " +
      '{ taskId, worktreePath, riskTier, boundaryTouching, baseRef, branch?, result? }, whose riskTier/' +
      "boundaryTouching are recorded as steering.source:'caller-args'; 'quality-evaluation' " +
      '(review) { high, medium, low, diffContent, diff?, repoRoot?, worktreePath?, ' +
      'blockedReason? }, which REQUIRES passing gate evidence on the stream for the active ' +
      "phase attempt under the review requirement; 'plan-closeout' (plan) { specPath }, one " +
      "path for the unified spec; 'synthesis-closeout' (synthesize) { title, prBody, " +
      'baseBranch, headBranch }, which validates the body then opens the PR — recording its ' +
      'URL in state stays with the caller. ' +
      'A caller-supplied `operationId` replays: the same id with the same request returns ' +
      'the persisted receipt and executes nothing; a different request under it is rejected.',
    schema: z
      .object({
        intent: z.string().min(1),
        args: coercedRecord().optional(),
        /** An alias of `featureId`, as in `task_complete`, because the stream id is the bare featureId. */
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
        operationId: z.string().optional(),
      })
      .strict(),
    /**
     * The union of the phase families of the shipped intents. Only the next-actions computer reads it.
     * It must not equal the plan phase set, because an action with exactly that set counts as a plan gate.
     * No exported constant holds `synthesize` alone, so it is a literal.
     */
    phases: new Set<string>([
      ...DELEGATE_PHASES,
      ...REVIEW_PHASES,
      ...PLAN_PHASES,
      'synthesize',
    ]),
    roles: ROLE_ANY,
    /** The leaves run in-process, and some gates run lint, typecheck, or test commands. */
    longRunning: true,
    outputSchema: withCappedShape(IntentExecutedOutputSchema),
    economy: {
      budgetTokens: EXECUTE_INTENT_ECONOMY_BUDGET_TOKENS,
      summarize: summarizeIntentReceipt,
    },
    annotations: LOCAL_MUTATION,
  }, {
    requires: none(
      'leaf admission is evaluated per leaf in execution order; the shipped leaves ' +
        'declare no gate requirements — their evidence dependencies live in handler reads',
    ),
    /**
     * No postcondition is declared, because of the replay contract.
     * The ensures observation looks for an `orchestrate.intent_executed` row with the operation id of the current dispatch.
     * A replay appends nothing and returns `success: true`, so an event-append ensure refuses every replay.
     * The executor tests check the first-commit append instead.
     */
    ensures: none(
      'the operation record is appended once, on the call that commits; a replay ' +
        'returns the persisted receipt without appending, so a per-dispatch ' +
        'append observation would refuse the replay path by construction',
    ),
    /**
     * `fs:write` is the write of the executor itself. It puts the run interior in the run-bundle store before the record commits.
     * A posture that denies filesystem writes must deny this action.
     */
    needs: declared('fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec'),
    /**
     * The leaves address paths, worktrees, and git refs through the typed args of the intent, not top-level request fields.
     * The plan-closeout intent binds its four document spellings from `args.specPath`.
     * There is no `vcs` stream entry. A declared infrastructure stream wins over the arg-derived stream.
     * So that entry moves the post-dispatch observation of this action to the vcs stream, where it declares no unconditional emission.
     */
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'args.worktreePath' },
      { kind: 'worktree', selector: 'args.worktreePath' },
      { kind: 'git-ref', selector: 'args.branch' },
      { kind: 'path', selector: 'args.specPath' },
      { kind: 'git-ref', selector: 'args.baseBranch' },
      { kind: 'git-ref', selector: 'args.headBranch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    /**
     * The emission is `conditional`, because the verifier queries by the operation id of the returning dispatch.
     * A replay appends nothing under that id. With `always`, every replay records an `emission.violated` row.
     */
    emissions: declared({
      event: 'orchestrate.intent_executed',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description:
        'appended when an operation commits for the first time; a replay of an ' +
        'already-claimed operation id returns the persisted receipt and appends nothing',
    }),
  }),
];
