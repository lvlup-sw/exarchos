// ─── The compilation endpoint's public action ────────────────────────────────
//
// `prepare` compiles a workflow's outstanding delegation batch into ONE
// immutable capsule and records `workflow.prepared` pinning its digest. The
// compiler, the custody write and the record live in `verbs/prepare/`; this
// file is only the registration — schema, contract, economy — that makes the
// action reachable.
//
// It is the first of the semantic plane's two calls, and `settle` is the
// second: the harness runs the capsule in between with no governance calls,
// and settlement judges what comes back against the capsule recorded here.

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
      "Compile a feature workflow's outstanding delegation batch into ONE immutable capsule and " +
      'commit one workflow.prepared record pinning its digest. Call it in the delegate phase. The ' +
      'capsule carries the task graph, each task\'s result contract, the admitted evidence kinds, ' +
      'the deviation envelope and the authority the batch will be settled against. Run the batch ' +
      'from the capsule with no further governance calls, then submit the results with `settle` ' +
      '(`capsuleVersion` plus a `batchId`). A retry with unchanged inputs returns the recorded ' +
      'capsule; changed inputs compile the next version. Refused before any effect: ' +
      'WORKFLOW_NOT_FOUND, WORKFLOW_TYPE_UNSUPPORTED, PHASE_NOT_PREPARABLE, NOTHING_TO_PREPARE, ' +
      'INVALID_TASK_ID, UNKNOWN_DEPENDENCY, CAPSULE_UNSOUND.',
    schema: z
      .object({
        // Alias, matching settle: `streamId` IS the bare featureId; either
        // spelling is accepted and exactly one is required.
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
      })
      .strict(),
    // Advisory — only the next-actions computer reads it. A batch is compiled
    // from the delegate phase's outstanding work, and nowhere else.
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
    // The same replay shape `settle` states: a replay is answered from the
    // persisted claim before any effect and appends nothing, so an event-append
    // ensure would refuse the replay path by construction.
    ensures: none(
      'the prepared record is appended once, on the call that compiles; a replay returns the ' +
        'recorded capsule without appending, so a per-dispatch append observation would refuse ' +
        'the replay path by construction',
    ),
    // `fs:read` is the repository's configuration and invariants catalog;
    // `fs:write` is the capsule reaching content-addressed custody before the
    // record that names it commits.
    needs: declared('fs:read', 'fs:write'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({
      event: 'workflow.prepared',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description:
        'appended when a compilation is recorded; a retry with unchanged inputs returns the ' +
        'recorded capsule and appends nothing, and a refusal appends nothing',
    }),
  }),
];
