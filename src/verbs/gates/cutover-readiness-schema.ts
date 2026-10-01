/**
 * Response contracts for `cutover_readiness` and `cutover_decide`.
 *
 * The schemas live apart from the handler file, so `registry.ts` can import them without the
 * event store and the rest of the promotion path.
 *
 * Each closed value set with a runtime authority derives from that authority. The sets that exist
 * only as TypeScript unions (`GateConditionId`, `LiveShadowObserverStatus`,
 * `DisagreementDisposition`) are `z.string().min(1)` on purpose. A copied enum is a second
 * authority that no compiler binds to the first.
 *
 * The MCP adapter replaces a non-conforming envelope with INTERNAL_ERROR. A schema stricter than
 * the real handler output thus turns a correct response into an error, so each object is
 * `.passthrough()`. `withCappedShape` adds the capped-response fallback at the registry.
 */

import { z } from 'zod';

import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { AdmissionRolloutDecisionData } from '../../events/schemas.js';
import { ALL_PHASE_KINDS } from '../../workflow/admission/cutover-gate.js';
import { DISAGREEMENT_CLASSES } from '../../workflow/admission/shadow-decision.js';

/** The phase-kind universe the gate measures coverage over. */
const PhaseKindSchema = z.enum(ALL_PHASE_KINDS);

/**
 * A count per disagreement class. The record is exhaustive on purpose, because `emptyTally()`
 * seeds each class. A missing class reads the same as a real zero, so the contract refuses a
 * partial tally.
 */
const DisagreementClassTallySchema = z.record(
  z.enum(DISAGREEMENT_CLASSES),
  z.number().int().nonnegative(),
);

/**
 * The rollout outcome, from the registered `admission.rollout-decision` event schema. The verb
 * thus cannot report an outcome that the event store refuses to record.
 */
const RolloutOutcomeSchema = AdmissionRolloutDecisionData.unwrap().shape.outcome;

/**
 * One of the six cutover conditions. `id` is a non-empty string, not a copy of the
 * `GateConditionId` union. `detail` is required, because a `met: false` condition without a
 * reason is not actionable.
 */
export const CutoverGateConditionSchema = z
  .object({
    id: z.string().min(1),
    met: z.boolean(),
    detail: z.string(),
  })
  .passthrough();

/**
 * The six-condition gate report as it crosses the tool boundary. It mirrors `CutoverGateReport`
 * (`workflow/admission/cutover-gate.ts`) field for field.
 *
 * `conditions` is `.min(1)`, because zero conditions make "everything is met" true for the wrong
 * reason. A refinement makes `unmet` and `satisfied` agree with `conditions`.
 */
export const CutoverGateReportSchema = z
  .object({
    satisfied: z.boolean(),
    conditions: z.array(CutoverGateConditionSchema).min(1),
    /** Ids of the conditions NOT met. Empty iff `satisfied`. */
    unmet: z.array(z.string().min(1)),
    unexplainedDisagreements: z.number().int().nonnegative(),
    liveAttemptCount: z.number().int().nonnegative(),
    comparableLiveAttemptCount: z.number().int().nonnegative(),
    nonComparableLiveAttemptCount: z.number().int().nonnegative(),
    liveDisagreementClasses: DisagreementClassTallySchema,
    durableAttemptCount: z.number().int().nonnegative(),
    nonComparableDurableAttemptCount: z.number().int().nonnegative(),
    durableDisagreementClasses: DisagreementClassTallySchema,
    observerStatus: z.string().min(1),
    coveredPhaseKinds: z.array(PhaseKindSchema),
    missingPhaseKinds: z.array(PhaseKindSchema),
    hasAllowOutcome: z.boolean(),
    hasDenyOutcome: z.boolean(),
  })
  .passthrough()
  .superRefine((report, ctx) => {
    const derivedUnmet = report.conditions.filter((c) => !c.met).map((c) => c.id);
    const sameSet =
      derivedUnmet.length === report.unmet.length &&
      [...derivedUnmet].sort().every((id, i) => id === [...report.unmet].sort()[i]);
    if (!sameSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unmet'],
        message:
          `unmet [${report.unmet.join(', ')}] disagrees with the conditions reporting ` +
          `met: false [${derivedUnmet.join(', ')}] — a report that names a different ` +
          'failure set than its own conditions cannot be acted on.',
      });
    }
    if (report.satisfied !== (derivedUnmet.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['satisfied'],
        message:
          `satisfied: ${String(report.satisfied)} contradicts ${derivedUnmet.length} ` +
          'unmet condition(s). `satisfied` is true exactly when nothing is unmet.',
      });
    }
  });

/**
 * The durable-substrate summary that both verbs attach beside the report. It names the features
 * with a sidecar evidence stream, the count of readable attempt rows, and their dispositions.
 *
 * The summary makes an empty store visible. All conditions unmet with `attemptCount: 0` means no
 * evidence. The same report with a non-zero count means evidence that does not clear the bar.
 */
export const DurableEvidenceSummarySchema = z
  .object({
    featureIds: z.array(z.string().min(1)),
    attemptCount: z.number().int().nonnegative(),
    dispositionTally: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .passthrough();

/** The shape `durableSummary()` builds — the handler's binding to this contract. */
export type DurableEvidenceSummary = z.infer<typeof DurableEvidenceSummarySchema>;

/** `cutover_readiness`'s success payload. Read-only: a report and its substrate. */
export const CutoverReadinessData = z
  .object({
    report: CutoverGateReportSchema,
    durableEvidence: DurableEvidenceSummarySchema,
  })
  .passthrough();

/**
 * The success payload of `cutover_decide`. `enablementId` is required, because the success branch
 * runs only after `toEnforcementEnabledData` accepts the report. An unsatisfied gate returns the
 * typed `CUTOVER_GATE_NOT_SATISFIED` failure instead.
 */
export const CutoverDecideData = z
  .object({
    outcome: RolloutOutcomeSchema,
    rolloutDecisionId: z.string().min(1),
    enablementId: z.string().min(1),
    report: CutoverGateReportSchema,
    durableEvidence: DurableEvidenceSummarySchema,
  })
  .passthrough();

/** The per-action envelope contracts the registry declares. */
export const CutoverReadinessOutputSchema = EnvelopeSchema(CutoverReadinessData);
export const CutoverDecideOutputSchema = EnvelopeSchema(CutoverDecideData);
