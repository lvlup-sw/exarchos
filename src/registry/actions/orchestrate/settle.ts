// ─── The settlement endpoint's public action ─────────────────────────────────
//
// `settle` adjudicates ONE batch of returned claims against the capsule that
// was pinned when the work was compiled. The adjudicator and the custody write
// live in `verbs/settle/`; this file is only the registration — schema,
// contract, economy — that makes the action reachable.
//
// It runs nothing. That is the asymmetry with `execute_intent`, and it is why
// nothing was reused from it: the executor compiles a named intent and runs
// leaves in-process, while this action performs no work of its own and judges
// work already done. What the two DO share is the substrate underneath —
// content-addressed custody, canonical encoding, the operation claim — and that
// is imported rather than re-implemented.

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
    // Trimmed to the per-action description budget: what the call decides, what
    // it runs, the one thing a caller cannot discover from the schema (that a
    // refusal is a successful settlement, not an error), and the refusals that
    // are errors.
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
        // Alias, matching execute_intent: `streamId` IS the bare featureId;
        // either spelling is accepted and exactly one is required.
        streamId: z.string().min(1).optional(),
        featureId: z.string().min(1).optional(),
      })
      .strict(),
    // Advisory — only the next-actions computer reads it. Settlement follows
    // work that was delegated and reviewed, which is where a returned batch
    // comes from. Deliberately not the plan family: nothing is compiled here.
    phases: new Set<string>([...DELEGATE_PHASES, ...REVIEW_PHASES]),
    roles: ROLE_ANY,
    // Runs each accepted task's compiled segment in-process, including the
    // gates that shell out to the project's toolchain — the same reason
    // `execute_intent` and each of those gates carry the flag.
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
    // No declared postcondition, and the reason is the replay contract rather
    // than an absence of durable effect — the same shape `execute_intent`
    // states. The dispatch-level ensures observation asks the store for a row
    // carrying the CURRENT dispatch's operation id. A replay is answered from
    // the persisted claim before any effect, appends nothing, and returns
    // success; an event-append ensure would therefore refuse every replay for
    // the absence of a row the replay is defined not to write.
    ensures: none(
      'the settlement record is appended once, on the call that adjudicates; a replay ' +
        'returns the persisted verdict without appending, so a per-dispatch append ' +
        'observation would refuse the replay path by construction',
    ),
    // `fs:write` is the adjudication interior reaching content-addressed
    // custody under the state directory, before the record that names it
    // commits. `mcp:exarchos` and `shell:exec` are the composed segment's: its
    // leaves are the ladder gates, which shell out to the toolchain, and the
    // completion leaf, and a posture that denies either must deny this action
    // rather than admit one that runs them.
    needs: declared('fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      // Each accepted claim names the worktree its segment runs against, and
      // the branch its gates diff; both live inside the claim, not at the top
      // of the request.
      { kind: 'path', selector: 'claims[].fields.worktreePath' },
      { kind: 'worktree', selector: 'claims[].fields.worktreePath' },
      { kind: 'git-ref', selector: 'claims[].fields.branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    // `conditional` for the same reason the executor's is: a replay returns the
    // persisted verdict without appending anything under the returning
    // dispatch's operation id. Declared unconditionally, every replay would be
    // reported as drift between the declaration and the handler — and recorded
    // as an `emission.violated` row — for doing exactly what the replay
    // contract says it does.
    // Only this action's OWN append is declared. The gate rows, the completion
    // fact and the per-segment operation records a settlement leaves are
    // appended by the leaves it composes, each under its own derived operation
    // id and each declared by its own registration — the same line
    // `execute_intent` draws around the leaves it runs.
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
