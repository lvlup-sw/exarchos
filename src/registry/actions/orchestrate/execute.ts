// ─── The bounded action executor's public action ─────────────────────────────
//
// `execute_intent` compiles a NAMED intent into a segment of already-registered
// local actions and runs it leaf by leaf, committing one operation record on
// both the committed and the failed path. The compiler and the run loop live
// in `verbs/execute/`; this file is only the registration — schema, contract,
// economy — that makes the action reachable.

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
    // Trimmed to the per-action description budget: the shipped intents, their
    // args, the one precondition a caller cannot discover from a schema, and
    // the one obligation a committed receipt leaves behind. The reasons behind
    // each required field live on the argument schemas.
    description:
      'Compile a NAMED intent (a runbook id) into a segment of already-registered local ' +
      'actions and run it leaf by leaf, committing one orchestrate.intent_executed record ' +
      "on either outcome. `args` is validated against that intent's own typed schema — the " +
      "caller can never submit an action array. Intents: 'task-completion' (delegate) " +
      '{ taskId, worktreePath, riskTier, boundaryTouching, branch? }, whose riskTier/' +
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
        // Alias, matching task_complete: `streamId` IS the bare featureId;
        // either spelling is accepted and exactly one is required.
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
        operationId: z.string().optional(),
      })
      .strict(),
    // The union of the shipped intents' phase families. Advisory — only the
    // next-actions computer reads it — but it must not EQUAL the plan binding:
    // an action whose phase set is exactly that set is treated as a canonical
    // plan gate, and this one is an executor, not a gate. The synthesize member
    // is the literal set the PR-stack gate binds to; there is no exported
    // constant for that phase alone.
    phases: new Set<string>([
      ...DELEGATE_PHASES,
      ...REVIEW_PHASES,
      ...PLAN_PHASES,
      'synthesize',
    ]),
    roles: ROLE_ANY,
    // Runs the compiled segment's leaves in-process, including gates that
    // shell out to lint/typecheck/test commands (check_static_analysis,
    // check_test_adequacy, check_contract_drift) — each of which already
    // carries its own `longRunning: true` for the same reason.
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
    // No declared postcondition, and the reason is the replay contract rather
    // than an absence of durable effect. The dispatch-level ensures observation
    // asks the store for a `orchestrate.intent_executed` row carrying the
    // CURRENT dispatch's operation id. A replay — the same caller key with the
    // same request — is answered from the persisted claim before any effect,
    // appends nothing, and returns `success: true`. An event-append ensure
    // would therefore refuse every replay for the absence of a row the replay
    // is defined not to write. The first-commit append is not unchecked: the
    // executor's own suite asserts the operation event exists after a commit
    // and is absent after a crash, which is the property this declaration
    // could not state without also condemning replays.
    ensures: none(
      'the operation record is appended once, on the call that commits; a replay ' +
        'returns the persisted receipt without appending, so a per-dispatch ' +
        'append observation would refuse the replay path by construction',
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      // The compiled leaves address a path/worktree/git-ref triple through
      // the intent's OWN typed args, not a top-level request field — the
      // request schema above carries `intent`/`args`/subject identity only.
      { kind: 'path', selector: 'args.worktreePath' },
      { kind: 'worktree', selector: 'args.worktreePath' },
      { kind: 'git-ref', selector: 'args.branch' },
      // The plan-closeout leaves read one document under four spellings; the
      // intent binds all four from this single argument.
      { kind: 'path', selector: 'args.specPath' },
      // The synthesis-closeout leaves address a branch pair. Deliberately NOT
      // a `{ kind: 'stream', selector: 'vcs' }` entry: a declared
      // infrastructure stream WINS over the arg-derived one, so naming it here
      // would re-point this action's own post-dispatch observation at the vcs
      // stream — where it declares no unconditional emission to observe. The
      // leaf that writes there declares it for itself.
      { kind: 'git-ref', selector: 'args.baseBranch' },
      { kind: 'git-ref', selector: 'args.headBranch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    // `conditional`, not `always`. The post-dispatch emission verifier queries
    // by the operation id of the dispatch that is returning, and a replay
    // returns the persisted receipt without appending anything under that id.
    // Declared unconditionally, every replay would be reported as drift
    // between the declaration and the handler — and recorded as an
    // `emission.violated` row — for doing exactly what the replay contract
    // says it does. The condition is named here rather than left implicit.
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
