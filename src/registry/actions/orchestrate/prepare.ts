/**
 * The registration of the `prepare` action: schema, contract, and economy. `prepare` compiles the
 * outstanding delegation batch of a workflow into one immutable capsule. It records
 * `workflow.prepared` with the capsule digest. The compiler, the custody write, and the record are
 * in `verbs/prepare/`.
 *
 * `prepare` is the first call of the semantic plane, and `settle` is the second. Between them, the
 * harness runs the capsule with no governance calls.
 */

import { z } from 'zod';
import { withCappedShape } from '../../../output-schema-declaration.js';
import {
  PREPARE_ECONOMY_BUDGET_TOKENS,
  summarizePreparedCapsuleReceipt,
} from '../../../verbs/prepare/economy.js';
import { PreparedCapsuleOutputSchema } from '../../../verbs/prepare/schemas.js';
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

export const prepareActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'prepare',
    description:
      "Compile a feature workflow's ready tasks (pending, every blocker complete) into ONE " +
      'immutable capsule and commit one workflow.prepared record pinning its digest. Call it in the ' +
      'delegate phase, before each wave. The capsule carries the task graph, each task\'s result ' +
      'contract, the evidence kinds, the deviation envelope, the authority the batch is settled ' +
      'against, each task\'s verification terms (tier and boundary from the plan; base from ' +
      'synthesis.integrationBranch), and the execution profile — the capabilities the plane\'s ' +
      'calls need; a runtime lacking one is refused before it fans out. It announces ' +
      'each compiled task the stream has not heard of (`task.assigned`). Run the batch with no ' +
      'further governance calls, then submit results with `settle` (`capsuleVersion`, ' +
      '`batchId`). Unchanged inputs replay the recorded capsule; changed inputs compile the next ' +
      'version. Refused before any effect: WORKFLOW_NOT_FOUND, WORKFLOW_TYPE_UNSUPPORTED, ' +
      'PHASE_NOT_PREPARABLE, NOTHING_TO_PREPARE, NO_READY_TASKS, BASE_UNRESOLVED, INVALID_TASK_ID, ' +
      'INVALID_TASK_STAMP, UNKNOWN_DEPENDENCY, CAPSULE_UNSOUND, RUNTIME_UNFIT.',
    schema: z
      .object({
        /**
         * An alias, as in `settle`, because `streamId` is the bare featureId. The call needs at least
         * one of the two, and two values must match.
         */
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
      })
      .strict(),
    /**
     * Advisory: only the next-actions computer reads it. A batch comes from the outstanding work of
     * the delegate phase.
     */
    phases: new Set<string>([...DELEGATE_PHASES]),
    roles: ROLE_ANY,
    outputSchema: withCappedShape(PreparedCapsuleOutputSchema),
    economy: {
      budgetTokens: PREPARE_ECONOMY_BUDGET_TOKENS,
      summarize: summarizePreparedCapsuleReceipt,
    },
    annotations: LOCAL_MUTATION,
  }, {
    requires: none(
      'the compilation reads the workflow it compiles; the phase it needs is checked by the ' +
        'handler before any effect rather than consumed as a resolved gate floor',
    ),
    /**
     * A replay returns the persisted claim before any effect and appends nothing. An event-append
     * ensure then refuses every replay, so no postcondition is declared.
     */
    ensures: none(
      'the prepared record is appended once, on the call that compiles; a replay returns the ' +
        'recorded capsule without appending, so a per-dispatch append observation would refuse ' +
        'the replay path by construction',
    ),
    /**
     * `fs:read` reads the repository config and the invariants catalog. `fs:write` puts the capsule
     * into content-addressed custody before the record commits.
     */
    needs: declared('fs:read', 'fs:write'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      {
        event: 'workflow.prepared',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'appended when a compilation is recorded; a retry with unchanged inputs returns the ' +
          'recorded capsule and appends nothing, and a refusal appends nothing',
      },
      {
        event: 'task.assigned',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'one per compiled task the stream has not yet heard of, in the same commit as the record ' +
          'and ahead of it; none for a task already announced, on a replay, or on a refusal',
      },
    ),
  }),
];
