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
    // Trimmed to the per-action description budget: what the call decides, the
    // one thing a caller cannot discover from the schema (that a refusal is a
    // successful settlement, not an error), and the two refusals that are.
    description:
      'Adjudicate ONE batch of returned claims against a prepared capsule and commit one ' +
      'execution.settled record. `capsuleVersion` names the capsule prepare recorded; the terms ' +
      'come from that record, never from current state or a submitted document (a submitted ' +
      '`capsule` must match the record\'s digest). Each claim is read against that ' +
      "capsule's declared result shape for its task; evidence is checked against its admitted " +
      'kinds; deviations are checked against its envelope. Outcome is `settled`, `rejected` ' +
      '(a claim failed adjudication) or `deviation-pending` (a deviation inside the envelope ' +
      'needs approval). A REJECTED batch is a successful call: the findings say which claim ' +
      'to fix. Only a malformed request, a capsule that fails the published contract ' +
      '(CAPSULE_INVALID), one never prepared (CAPSULE_NOT_PREPARED) or not the one prepared ' +
      '(CAPSULE_DIGEST_MISMATCH), or one that does not resolve (CAPSULE_UNRESOLVED) answer ' +
      'with an error, and none of those adjudicates anything. ' +
      'A settlement is keyed by (capsule version, `batchId`): resubmitting the same batch ' +
      'returns the persisted verdict and adjudicates nothing, different claims under a ' +
      'settled batch are refused, and a corrected batch goes back under a NEW `batchId`.',
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
    // commits. A posture that denies filesystem writes must deny this action
    // rather than admit an action that writes.
    needs: declared('fs:read', 'fs:write'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    // `conditional` for the same reason the executor's is: a replay returns the
    // persisted verdict without appending anything under the returning
    // dispatch's operation id. Declared unconditionally, every replay would be
    // reported as drift between the declaration and the handler — and recorded
    // as an `emission.violated` row — for doing exactly what the replay
    // contract says it does.
    emissions: declared({
      event: 'execution.settled',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description:
        'appended on every adjudicated outcome, including a rejection; a replay of an ' +
        'already-claimed operation id returns the persisted verdict and appends nothing',
    }),
  }),
];
