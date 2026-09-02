import { withCappedShape } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';
import {
  CutoverDecideOutputSchema,
  CutoverReadinessOutputSchema,
} from '../../../verbs/gates/cutover-readiness-schema.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const cutoverActions: readonly BuiltinToolAction[] = [
  // ─── Cutover promotion path (#1739) ───────────────────────────────────────
  // The two verbs that consult the six-condition cutover gate over ONE local
  // store's durable shadow substrate (`workflow/admission/cutover-gate.ts` +
  // `evidence-reader.ts`). INV-5d: actions on exarchos_orchestrate, not a new
  // visible tool.
  contracted(
    {
      name: 'cutover_readiness',
      description:
        'Assess the six-condition cutover gate against this store: fold every <featureId>/admission-shadow sidecar stream (admission.shadow-attempt + admission.disagreement-disposition) plus the live shadow sink and observer health, and return the full CutoverGateReport with every unmet condition named individually. Read-only — appends nothing, writes nothing. An empty store yields NO evidence (unmet conditions), never clean evidence. Use for: checking how far the store is from flipping enforcement off the legacy HSM guard path. Do NOT use for: recording a rollout decision (use cutover_decide).',
      schema: z.object({}),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: withCappedShape(CutoverReadinessOutputSchema),
      annotations: READ_ONLY_LOCAL,
    },
    {
      requires: none('cutover_readiness is a read-only fold over shadow evidence'),
      ensures: none('cutover_readiness returns an ephemeral readiness report'),
      needs: none('cutover_readiness reads the in-process admission store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'exarchos-admission' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('cutover_readiness emits no catalog events'),
    },
  ),
  contracted(
    {
      name: 'cutover_decide',
      description:
        "Event-source the enforcement rollout decision (operator-only, T-03 pattern: the ambient dispatch authorization must carry role 'operator' with a mutating posture — a delegated agent is denied). Runs the identical six-condition assessment to cutover_readiness, ALWAYS appends an admission.rollout-decision fact (outcome derived from the evidence: approve-enforcement or continue-shadow), and appends admission.enforcement-enabled ONLY when the gate is satisfied — an unsatisfied gate returns a typed CUTOVER_GATE_NOT_SATISFIED error naming the unmet conditions. Both facts land on the reserved exarchos-admission stream under natural-identity idempotency keys. Use for: recording the governance decision to flip (or keep shadowing). Do NOT use for: a side-effect-free readiness check (use cutover_readiness).",
      schema: z.object({}),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      // Mutates shared governance state (the store-wide enforcement posture) —
      // the strictest mutating trust tier, so the resolver gate rejects
      // read-only / task-isolated callers BEFORE the handler's operator check.
      posture: 'shared-mutating',
      outputSchema: withCappedShape(CutoverDecideOutputSchema),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('cutover_decide is store-scoped; the handler gates on operator posture'),
      ensures: declared(
        { source: 'event-append', when: 'always', event: 'admission.rollout-decision' },
        { source: 'event-append', when: 'success', event: 'admission.enforcement-enabled' },
      ),
      needs: none('cutover_decide appends through the in-process admission store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'exarchos-admission' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(
        {
          event: 'admission.rollout-decision',
          condition: 'always',
          role: 'primary',
          owner: 'orchestrate',
        },
        {
          event: 'admission.enforcement-enabled',
          condition: 'conditional',
          description: 'Only when every cutover-gate condition is satisfied',
          role: 'primary',
          owner: 'orchestrate',
        },
      ),
    },
  ),
];
