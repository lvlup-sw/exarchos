// ─── The cutover verbs' response contracts (DR-4/DR-6, task 083) ─────────────
//
// WHY THIS FILE EXISTS
//
// `cutover_readiness` and `cutover_decide` arrived NEW and still declared
// `outputSchema: vacuityWaiver(...)`, with their two rows seeded into
// `output-schema-vacuity-allowlist.ts` in the same change. DR-4's first tooth
// says a new action may not declare a vacuous `outputSchema` at all — the
// allowlist is a record of INHERITED debt, not an intake form — and the third
// new verb of that same change (`invariants_amend`) held itself to exactly that
// rule, writing `AmendInvariantData` rather than acquiring a waiver. Both
// handlers already returned fully typed shapes (`CutoverGateReport` is a shipped
// interface), so these contracts were writable the day the verbs landed. Task
// 083 writes them and MOVES both rows to `VACUITY_RETIRED`.
//
// WHY A SEPARATE MODULE AND NOT THE HANDLER FILE
//
// `registry.ts` must import the schemas. `orchestrate/cutover-readiness.ts`
// imports the event store, the dispatch context and the admission provenance
// parsers; hanging the registry off that import closure would drag the whole
// promotion path into every consumer that only wants to read a contract. Same
// split, same reason, as `check-invariant-conformance-schema.ts` (task 069's
// paydown) and `orchestrate/worktree/schemas.ts`.
//
// ── ONE AUTHORITY PER VOCABULARY (DR-6) ─────────────────────────────────────
// Every closed value set below that HAS a runtime authority is derived from it
// rather than re-spelled: the phase-kind universe from `ALL_PHASE_KINDS`, the
// disagreement classes from `DISAGREEMENT_CLASSES`, the rollout outcome from the
// registered `admission.rollout-decision` schema — which is the very field this
// verb reports, so the contract and the recorded fact cannot drift apart.
//
// The sets that have NO runtime authority (`GateConditionId`,
// `LiveShadowObserverStatus`, `DisagreementDisposition` — all three exist only
// as TypeScript unions) are typed `z.string().min(1)` DELIBERATELY. Re-spelling
// their members here would create a second authority for a vocabulary whose
// first one is a type, and a second authority that no compiler binds to the
// first is exactly the drift DR-6 exists to remove. A non-empty string is a real
// constraint; a duplicated enum is a maintenance liability wearing one.
//
// DO NOT OVER-CONSTRAIN. The MCP adapter's D.5 validator replaces a
// non-conforming envelope with an INTERNAL_ERROR, so a schema stricter than the
// handlers' real emissions would turn a correct response into an error. Every
// field below is one the corresponding handler emits on EVERY success path, and
// each object is `.passthrough()` so a later decorator does not require
// re-cutting the contract. `withCappedShape` unions the capped-response fallback
// in at the registry.

import { z } from 'zod';

import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { AdmissionRolloutDecisionData } from '../../events/schemas.js';
import { ALL_PHASE_KINDS } from '../../workflow/admission/cutover-gate.js';
import { DISAGREEMENT_CLASSES } from '../../workflow/admission/shadow-decision.js';

/** The phase-kind universe the gate measures coverage over. */
const PhaseKindSchema = z.enum(ALL_PHASE_KINDS);

/**
 * A count per disagreement class. EXHAUSTIVE on purpose: `evaluateCutoverGate`
 * folds every tally out of `emptyTally()`, which seeds all five classes, and
 * `DisagreementClassTally` documents that "every class is always present". A
 * partial tally would mean a class silently stopped being counted — the reader
 * cannot tell that from a genuine zero, so the contract refuses it.
 */
const DisagreementClassTallySchema = z.record(
  z.enum(DISAGREEMENT_CLASSES),
  z.number().int().nonnegative(),
);

/**
 * The rollout outcome, taken from the registered `admission.rollout-decision`
 * event schema — the same enum the fact this verb appends is validated against.
 * Deriving it here means the verb cannot advertise an outcome the event store
 * would refuse to record.
 */
const RolloutOutcomeSchema = AdmissionRolloutDecisionData.unwrap().shape.outcome;

/**
 * One of the six cutover conditions, reported individually.
 *
 * `id` is `z.string().min(1)` rather than a re-spelled `GateConditionId` union —
 * see the DR-6 note in the header. `detail` is the human-readable sentence the
 * gate builds for the condition, and it is REQUIRED: a condition that reports
 * `met: false` with no explanation is the shape of an unactionable gate.
 */
export const CutoverGateConditionSchema = z
  .object({
    id: z.string().min(1),
    met: z.boolean(),
    detail: z.string(),
  })
  .passthrough();

/**
 * The full six-condition gate report as it crosses the tool boundary. Mirrors
 * `CutoverGateReport` (`workflow/admission/cutover-gate.ts`) field for field.
 *
 * `conditions` is `.min(1)`: the gate's whole claim is that it names every unmet
 * condition individually, and a report carrying ZERO conditions makes
 * "everything is met" true for the worst possible reason. That reading must not
 * cross the boundary as a clean one.
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
  // `unmet` and `satisfied` are DERIVABLE from `conditions`, and until now
  // nothing checked that they agreed with it. A report could carry
  // `satisfied: true` beside a condition with `met: false`, or an `unmet` list
  // naming conditions that were met — each field individually valid, the
  // document as a whole self-contradictory. The header above says the
  // everything-is-met reading must not cross the boundary as a clean one; this
  // is what stops it, and it makes the doc-comment on `unmet` ("Empty iff
  // `satisfied`") enforced rather than aspirational.
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
 * The durable-substrate summary both verbs attach beside the report: which
 * features own a sidecar evidence stream, how many attempt rows were readable,
 * and how those rows were disposed.
 *
 * This is what makes an EMPTY store legible. A report with every condition unmet
 * and `attemptCount: 0` is "no evidence"; the same report with a non-zero count
 * is "evidence that does not clear the bar". Without the summary the two read
 * identically, which is the reading DR-23 exists to prevent.
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
 * `cutover_decide`'s success payload.
 *
 * `enablementId` is REQUIRED here because the success branch is reached ONLY
 * after `toEnforcementEnabledData` accepted the report: an unsatisfied gate
 * leaves through the typed `CUTOVER_GATE_NOT_SATISFIED` failure instead. So on
 * this branch the enablement fact always exists, and a caller may rely on the
 * id without probing for it.
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
