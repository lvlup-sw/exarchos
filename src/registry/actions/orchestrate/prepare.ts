/**
 * The registration of the `prepare` action: schema, contract, and economy. `prepare` compiles the
 * outstanding delegation batch of a workflow into one immutable capsule. It records
 * `workflow.prepared` with the capsule digest. The first compilation after a design revision also
 * records `capsule.recompiled`. The compiler, the custody write, and the records are in
 * `verbs/prepare/`.
 *
 * `prepare` is the first call of the semantic plane, and `settle` is the second. Between them, the
 * harness runs the capsule with no governance calls.
 */

import { z } from 'zod';
import { withCappedShape } from '../../../output-schema-declaration.js';
import {
  PREPARE_DETAIL_READ,
  PREPARE_ECONOMY_BUDGET_TOKENS,
  summarizePreparedCapsuleReceipt,
} from '../../../verbs/prepare/economy.js';
import { PrepareIntentSchema } from '../../../verbs/prepare/intent.js';
import { ABSOLUTE_REPO_ROOT } from '../../../verbs/prepare/prepare-scope.js';
import { PreparedCapsuleOutputSchema } from '../../../verbs/prepare/schemas.js';
import { declared, none, withActionContract, type ActionContract, type ActionEmission } from '../../action-contract.js';
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

function bootstrapEmission(event: string, description: string): ActionEmission {
  return { event, description, condition: 'conditional', owner: 'workflow', role: 'primary' };
}

export const prepareActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'prepare',
    description:
      'Compile ready tasks of a task-batch step into one capsule and record workflow.prepared. ' +
      'Bootstrap an empty stream with type, base, relative designRef and approved SHA-256. ' +
      'Use compile intent for later typed preparation. Legacy plans allow no intent. ' +
      'Repeat a bootstrap request to recover its receipt or repair its document. ' +
      'Run without governance calls, then settle with capsuleVersion and batchId. ' +
      'Refusals: WORKFLOW_NOT_FOUND, BOOTSTRAP_UNSUPPORTED, BOOTSTRAP_CONFLICT, BOOTSTRAP_INTEGRITY, STATE_SYNC_FAILED, PREPARE_INTENT_REQUIRED, ' +
      'DESIGN_APPROVAL_MISMATCH, PLAN_UNSOUND, PREPARED_AUTHORITY_INVALID, INTERNAL_ERROR, ' +
      'WORKFLOW_TYPE_UNSUPPORTED, PHASE_NOT_PREPARABLE, NOTHING_TO_PREPARE, NO_READY_TASKS, ' +
      'BASE_UNRESOLVED, SCOPE_UNRESOLVED, INVALID_TASK_ID, INVALID_TASK_STAMP, UNKNOWN_DEPENDENCY, ' +
      'CAPSULE_UNSOUND, RUNTIME_UNFIT, REVISION_UNREADABLE.',
    schema: z
      .object({
        /**
         * An alias, as in `settle`, because `streamId` is the bare featureId. The call needs at least
         * one of the two. When it passes both, the values must match.
         */
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
        intent: PrepareIntentSchema.optional(),
        /**
         * Required, with the absolute pattern, the base type string and no default. Dispatch and `describe` apply the pattern.
         * The MCP wire schema keeps the first declaration of the field, so the handler checks the rule again.
         */
        repoRoot: z
          .string()
          .regex(ABSOLUTE_REPO_ROOT, 'repoRoot must be an absolute path')
          .describe(
            'Absolute path of the worktree where the integration branch is checked out. The capsule pins its repository and checkout',
          ),
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
      detailRead: PREPARE_DETAIL_READ,
    },
    annotations: LOCAL_MUTATION,
  }, {
    requires: none(
      'the compilation reads the workflow it compiles; the phase it needs is checked by the ' +
        'handler before any effect rather than consumed as a resolved gate floor',
    ),
    /**
     * A replay returns the persisted claim before any effect and appends nothing. An event-append
     * ensure then refuses every replay, so the contract declares no postcondition.
     */
    ensures: none(
      'the prepared record is appended once, on the call that compiles; a replay returns the ' +
        'recorded capsule without appending, so a per-dispatch append observation would refuse ' +
        'the replay path by construction',
    ),
    /**
     * `fs:read` reads the repository config, the invariants catalog, and the settlement bundles of
     * the design revisions that the capsule binds. For a type that is not built in, it also
     * reads the definition files in `.exarchos/workflows/` of the checkout. `fs:write` puts the
     * capsule into content-addressed custody before the record commits. `shell:exec` runs git to
     * pin the repository and the base commit.
     */
    needs: declared('fs:read', 'fs:write', 'shell:exec'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      bootstrapEmission('workflow.started', 'the validated start of a new bootstrap'),
      bootstrapEmission('state.patched', 'the approved compatibility fields of a new bootstrap'),
      bootstrapEmission('phase.entered', 'the initial entry and each admitted bootstrap entry'),
      bootstrapEmission('workflow.transition', 'each admitted hop in a new bootstrap'),
      bootstrapEmission('phase.exited', 'each discharged source in a new bootstrap'),
      bootstrapEmission('workflow.compound-entry', 'each group entry in a new bootstrap'),
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
      {
        event: 'capsule.recompiled',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'one on the first compilation after a design revision, in the same commit as the ' +
          'record, after the announcements and ahead of the record; none on any other ' +
          'compilation, on a replay, or on a refusal',
      },
    ),
  }),
];
