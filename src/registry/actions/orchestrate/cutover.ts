import { withCappedShape } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';
import {
  CutoverDecideOutputSchema,
  CutoverReadinessOutputSchema,
} from '../../../verbs/gates/cutover-readiness-schema.js';

export const cutoverActions: readonly BuiltinToolAction[] = [
  // ─── Cutover promotion path (#1739) ───────────────────────────────────────
  // The two verbs that consult the six-condition cutover gate over ONE local
  // store's durable shadow substrate (`workflow/admission/cutover-gate.ts` +
  // `evidence-reader.ts`). INV-5d: actions on exarchos_orchestrate, not a new
  // visible tool.
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
    autoEmits: [
      { event: 'admission.rollout-decision', condition: 'always' },
      { event: 'admission.enforcement-enabled', condition: 'conditional', description: 'Only when every cutover-gate condition is satisfied' },
    ],
    outputSchema: withCappedShape(CutoverDecideOutputSchema),
    annotations: LOCAL_MUTATION,
  },
];
