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
import { DELEGATE_PHASES, ROLE_ANY } from '../../phases.js';
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
    description:
      'Compile a NAMED intent into a segment of already-registered local actions and ' +
      "run it leaf by leaf, committing one orchestrate.intent_executed record on both " +
      "the committed and the failed path. `intent` names a runbook; `args` is validated " +
      "against that intent's own typed argument schema (Record<string,string> is not " +
      'accepted — the caller can never submit an action array). The one shipped intent ' +
      "is 'task-completion' (the delegate-phase runbook: check_test_adequacy, " +
      'check_contract_drift, check_mock_boundary, check_static_analysis, then the ' +
      "terminal task_complete), whose args are { taskId, worktreePath, branch?, " +
      "riskTier?, boundaryTouching? }. riskTier/boundaryTouching are recorded on the " +
      "receipt with steering.source:'caller-args' — no durable per-task stamp exists " +
      'yet to read them from instead. A caller-supplied `operationId` replays: the same ' +
      'id with the same request returns the persisted receipt and executes nothing; the ' +
      'same id with a different request is rejected.',
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
    phases: DELEGATE_PHASES,
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
