/**
 * The registration of the `settle` action: schema, contract, and economy. `settle` judges one batch
 * of returned claims against the capsule that was pinned at compile time. The judge and the custody
 * write are in `verbs/settle/`.
 *
 * Unlike `execute_intent`, it takes no intent name from the caller. It judges returned work, then
 * compiles and runs the task-completion segment of each accepted task. The two share
 * content-addressed custody, canonical encoding, and the operation claim.
 */

import { z } from 'zod';
import { withCappedShape } from '../../../output-schema-declaration.js';
import { SETTLE_ECONOMY_BUDGET_TOKENS, summarizeSettlementReceipt } from '../../../verbs/settle/economy.js';
import { SettlementOutputSchema } from '../../../verbs/settle/schemas.js';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION } from '../../annotations.js';
import { DELEGATE_PHASES, REVIEW_PHASES, ROLE_ANY } from '../../phases.js';
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

export const settleActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'settle',
    /**
     * The text fits the per-action description budget. It names the fact that the schema cannot
     * show: a rejected batch is a successful call, not an error.
     */
    description:
      'Adjudicate ONE batch of returned claims against a prepared capsule, verify each accepted ' +
      'task, and commit one execution.settled record. `capsuleVersion` names the capsule prepare ' +
      'recorded; the terms come from that record, never from current state. Claims are read ' +
      'against each task\'s result shape, evidence must resolve to a recorded row of an admitted ' +
      'kind, deviations against the envelope. A batch with no finding then RUNS each task\'s ' +
      'task-completion segment (the ladder gates under the tier the capsule froze, then ' +
      'task_complete) against the claim\'s `worktreePath`; a halted segment is a ' +
      'verification-failed finding. A REJECTED batch is a successful call whose findings say ' +
      'what to fix. A HELD batch names `pendingDeviations`; settle the SAME batch again with ' +
      '`decisions` (no claims) to record each and verify the work, or reject it. Errors ' +
      '(nothing adjudicated): CAPSULE_INVALID, CAPSULE_NOT_PREPARED, CAPSULE_DIGEST_MISMATCH, ' +
      'CAPSULE_UNRESOLVED, BATCH_NOT_HELD, DECISION_INCOMPLETE. Keyed by (capsuleVersion, ' +
      '`batchId`): a resubmitted batch returns its verdict; a correction takes a NEW `batchId`.',
    schema: z
      .object({
        capsuleVersion: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('The capsule version prepare returned. Required unless the capsule itself is submitted'),
        capsule: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional: the compiled capsule document, checked against the prepared record by digest'),
        batchId: z
          .string()
          .min(1)
          .describe(
            'Names this batch. With the capsule version it is the settlement key: a retry reuses ' +
              'it, a correction of a rejected batch takes a new one',
          ),
        claims: z
          .array(
            z
              .object({
                taskId: z.string().min(1),
                fields: z.record(z.string(), z.unknown()).optional(),
                evidence: z
                  .array(z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict())
                  .optional(),
              })
              .strict(),
          )
          .optional()
          .describe('The batch: one entry per task that returned a result'),
        deviations: z
          .array(
            z
              .object({ deviationKind: z.string().min(1), statement: z.string().min(1) })
              .strict(),
          )
          .optional()
          .describe("Deviations proposed because a capsule assumption did not hold"),
        decisions: z
          .array(
            z
              .object({
                deviationId: z.string().min(1),
                decision: z.enum(['accepted', 'rejected']),
                actor: z.string().min(1),
                rationale: z.string().min(1),
              })
              .strict(),
          )
          .optional()
          .describe(
            'The decision round of a held batch: one entry per deviation the held receipt named ' +
              'in pendingDeviations, and no claims',
          ),
        /**
         * An alias, as in `execute_intent`, because `streamId` is the bare featureId. The call needs
         * at least one of the two. When it passes both, the values must match.
         */
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
      })
      .strict(),
    /**
     * Advisory: only the next-actions computer reads it. A returned batch follows delegated and
     * reviewed work, so the plan phases are not in the set.
     */
    phases: new Set<string>([...DELEGATE_PHASES, ...REVIEW_PHASES]),
    roles: ROLE_ANY,
    /**
     * It runs the compiled segment of each accepted task in-process, and those gates shell out to
     * the project toolchain.
     */
    longRunning: true,
    outputSchema: withCappedShape(SettlementOutputSchema),
    economy: {
      budgetTokens: SETTLE_ECONOMY_BUDGET_TOKENS,
      summarize: summarizeSettlementReceipt,
    },
    annotations: LOCAL_MUTATION,
  }, {
    requires: none(
      'the capsule carries its own terms, pinned at compile time; a prior gate or approval ' +
        'floor read at settlement would be the current-state dependency a capsule exists to remove',
    ),
    /**
     * The replay contract is the reason for no postcondition. The ensures check looks for a row
     * with the operation id of the current dispatch. A replay appends nothing and returns success,
     * so an event-append ensure refuses every replay.
     */
    ensures: none(
      'the settlement record is appended once, on the call that adjudicates; a replay ' +
        'returns the persisted verdict without appending, so a per-dispatch append ' +
        'observation would refuse the replay path by construction',
    ),
    /**
     * `fs:write` is the custody write under the state directory, before the record commits.
     * `mcp:exarchos` and `shell:exec` belong to the composed segment, which runs the ladder gates
     * and the completion leaf. A posture that denies either one must deny this action.
     */
    needs: declared('fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec'),
    /**
     * Each accepted claim names the worktree that its segment runs against and the branch that its
     * gates diff. Both are inside the claim, not at the top of the request.
     */
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'claims[].fields.worktreePath' },
      { kind: 'worktree', selector: 'claims[].fields.worktreePath' },
      { kind: 'git-ref', selector: 'claims[].fields.branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    /**
     * Conditional, because a replay returns the persisted verdict and appends nothing. An
     * unconditional declaration reports every replay as an `emission.violated` row.
     *
     * The declaration names only the append of this action. The composed leaves append the gate
     * rows, the completion fact, and the segment operation records, and each leaf declares its own.
     */
    emissions: declared(
      {
        event: 'execution.settled',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'appended on every adjudicated outcome, including a rejection; a replay of an ' +
          'already-claimed operation id returns the persisted verdict and appends nothing',
      },
      {
        event: 'deviation.proposed',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'one per deviation a held batch waits on, in the same commit as the record that holds ' +
          'it and ahead of it; none on any other outcome, on the decision round, or on a replay',
      },
      {
        event: 'deviation.decided',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'one per decision the decision round records, in the same commit as the record that ' +
          'closes the batch and ahead of it; none on the submitting round or on a replay',
      },
    ),
  }),
];
