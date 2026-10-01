/**
 * Translates a legacy workflow state into admission evidence for one shared-IR edge.
 *  1. {@link projectStateToFacts} projects the state into the closed edge-condition fact vocabulary.
 *  2. Recorded proof facts in the event log govern each requirement that they claim.
 *     `selectEvidence` selects them, and `evaluatePolicy` evaluates their provenance.
 *     Only an unclaimed requirement falls back to an attestation derived from the projection.
 *  3. {@link evaluatePolicy} adjudicates the edge, composed with the route condition.
 *
 * The translation depends on the state and not on a scenario label. Identical state and context give an identical verdict.
 * Thus a shadow disagreement shows a real divergence between legacy and admission.
 * The module has no import path to a legacy guard module, and `built-in-workflow-ir.structure.test.ts` enforces this.
 * It is pure. The caller injects the evaluation instant.
 */

import { createHash } from 'node:crypto';

import {
  evaluateEdgeCondition,
  type EdgeConditionFacts,
  type EdgeConditionOutcome,
} from './edge-condition-evaluate.js';
import {
  selectEdge,
  type EdgeCandidate,
} from './edge-condition-select.js';
import type {
  CompiledEdgeCondition,
  EdgeConditionNode,
} from './edge-condition.js';
import {
  evaluatePolicy,
  type PolicyEvaluation,
  type PolicyVerdict,
} from './policy-evaluation.js';
import {
  createCapabilityAuthority,
  POLICY_CAPABILITY,
  type PolicyAuthority,
} from './policy-authority.js';
import type { ResolvedRequirements } from './requirement-strength.js';
import {
  selectEvidence,
  type EvidenceContradiction,
  type EvidenceSelectionDiagnostic,
} from './select-evidence.js';
import {
  ADMISSION_EVENT_TYPES,
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  ContentDigestV1Schema,
  EvidenceSubjectV1Schema,
  WaiverProvenanceV1Schema,
  type AdmissionEvidenceV1,
  type AdmissionRequirementV1,
  type ContentDigestV1,
  type EvidenceSubjectV1,
  type WaiverProvenanceV1,
} from './types.js';
import {
  BUILT_IN_WORKFLOW_IR,
  edgeKey,
  type EdgeObligation,
  type WorkflowEdgeIR,
} from './built-in-workflow-ir.js';

/** The producer/approver principal the translation attributes minted evidence to. */
export const TRANSLATION_PRODUCER_ID = 'translator.legacy-state';
export const TRANSLATION_PROVIDER_REF = 'provider.legacy-state-translation';
export const TRANSLATION_PROVIDER_VERSION = '1.0';
export const TRANSLATION_POLICY_ID = 'policy.legacy-state-translation';

/**
 * The out-of-band trust grants for the translation adjudication.
 * The caller declares them, because evidence issuers and waiver grantors are deployment trust decisions, not facts of the record.
 */
export interface TranslationTrustOptions {
  /**
   * Principals, other than the translator, that can issue gate evidence for a translated obligation.
   * Recorded evidence from any other producer is `unauthorized` and denies.
   */
  readonly gateEvidenceIssuers?: readonly string[];
  /** Principals trusted to issue APPROVAL evidence, beyond the translator. */
  readonly approvalIssuers?: readonly string[];
  /**
   * Principals that can grant a waiver. The default is empty, so no recorded waiver applies.
   * Thus waivers need an explicit, auditable grant.
   */
  readonly waiverGrantors?: readonly string[];
}

/**
 * An authority that trusts the translation producer for gate and approval evidence, plus the declared issuers and grantors.
 * A legacy state record, a recorded evidence fact, or a waiver cannot authorize itself.
 */
export function createTranslationAuthority(
  options: TranslationTrustOptions = {},
): PolicyAuthority {
  return createCapabilityAuthority([
    {
      principalId: TRANSLATION_PRODUCER_ID,
      capabilities: [
        POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE,
        POLICY_CAPABILITY.ISSUE_APPROVAL,
      ],
    },
    ...(options.gateEvidenceIssuers ?? []).map((principalId) => ({
      principalId,
      capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE],
    })),
    ...(options.approvalIssuers ?? []).map((principalId) => ({
      principalId,
      capabilities: [POLICY_CAPABILITY.ISSUE_APPROVAL],
    })),
    ...(options.waiverGrantors ?? []).map((principalId) => ({
      principalId,
      capabilities: [POLICY_CAPABILITY.GRANT_WAIVER],
    })),
  ]);
}

/** The trust, the instant, and the freshness horizon of one adjudication. */
export interface TranslationContext {
  readonly authority: PolicyAuthority;
  /** Trusted RFC3339 evaluation instant. Never `Date.now()`. */
  readonly evaluatedAt: string;
  /** Evidence older than this is stale. */
  readonly freshnessHorizonMs: number;
}

/**
 * A default translation context with a one-hour freshness horizon.
 * The derived attestation is stamped at `evaluatedAt`, so it is always fresh.
 * Recorded evidence carries the instant of its producer, so the horizon applies to it.
 */
export function defaultTranslationContext(
  evaluatedAt: string,
  options: TranslationTrustOptions = {},
): TranslationContext {
  return {
    authority: createTranslationAuthority(options),
    evaluatedAt,
    freshnessHorizonMs: 60 * 60 * 1000,
  };
}

/** Legacy status vocabularies, copied here as data and not imported from the guards. */
const PASSED_STATUSES: ReadonlySet<string> = new Set([
  'pass',
  'passed',
  'approved',
  'fixes-applied',
]);
const FAILED_STATUSES: ReadonlySet<string> = new Set([
  'fail',
  'failed',
  'needs_fixes',
]);
const TERMINAL_MERGE_EVENTS: ReadonlySet<string> = new Set([
  'merge.executed',
  'merge.rollback',
  'merge.recovered',
  'merge.aborted',
]);
const TERMINAL_MERGE_ORCHESTRATOR_PHASES: ReadonlySet<string> = new Set([
  'completed',
  'rolled-back',
  'recovered',
  'aborted',
  'failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/** Read a dotted path through nested plain objects, or `undefined` when the path leaves them. */
function readPath(state: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = state;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isTrue(value: unknown): boolean {
  return value === true;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The plan-revision cap when none is injected, the same as `DEFAULT_MAX_PLAN_REVISIONS` in `guards.ts`.
 * `handleSet` injects config values, such as `_maxPlanRevisions`, onto the state before the guards run.
 * The projection reads the same fields, so the IR has no second threshold that drifts toward over-admission.
 * The defaults here are copied as data, because this module cannot import `guards.ts`.
 * `legacy-guard-parity.test.ts` pins them against the real guards.
 */
const DEFAULT_MAX_PLAN_REVISIONS = 1;

/** Mirrors `guards.ts readSynthesisPolicy` — the policy when none is set. */
const DEFAULT_SYNTHESIS_POLICY = 'on-request';
const SYNTHESIS_POLICIES: ReadonlySet<string> = new Set([
  'always',
  'never',
  'on-request',
]);

/** Mirrors `guards.ts UNSAFE_KEYS` — prototype-pollution keys are never "present". */
const UNSAFE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/** The plan-revision cap of the legacy `revisionsExhausted` guard for this state: the injected value, or the default. */
function readMaxPlanRevisions(state: Record<string, unknown>): number {
  const raw = state['_maxPlanRevisions'];
  return typeof raw === 'number' && Number.isFinite(raw)
    ? raw
    : DEFAULT_MAX_PLAN_REVISIONS;
}

/**
 * The oneshot synthesis policy. An absent or unknown value becomes `'on-request'`, as in `readSynthesisPolicy` of the guards.
 * An empty-string default matches no branch, so every outbound edge of `implementing` denies and the workflow deadlocks.
 */
function readSynthesisPolicy(state: Record<string, unknown>): string {
  const raw = readPath(state, 'oneshot.synthesisPolicy');
  return typeof raw === 'string' && SYNTHESIS_POLICIES.has(raw)
    ? raw
    : DEFAULT_SYNTHESIS_POLICY;
}

/** The injected required-review dimensions, in the three shapes legacy can see. */
type RequiredReviewsSpec =
  | { readonly kind: 'unset' }
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'unsatisfiable' };

/**
 * Read the injected `_requiredReviews` the way the legacy guard sees it.
 * An array key that is not a string becomes its string form, as `hasOwnProperty` coerces it.
 * A non-empty string is unsatisfiable, because legacy demands one review dimension per character.
 * An object with a positive `length` is unsatisfiable, because the legacy `for...of` throws and the transition then denies.
 */
function readRequiredReviews(raw: unknown): RequiredReviewsSpec {
  if (Array.isArray(raw)) {
    return raw.length === 0
      ? { kind: 'unset' }
      : {
          kind: 'keys',
          keys: raw.map((k) => (typeof k === 'string' ? k : String(k))),
        };
  }
  if (typeof raw === 'string') {
    return raw.length === 0 ? { kind: 'unset' } : { kind: 'unsatisfiable' };
  }
  if (isRecord(raw) && typeof raw['length'] === 'number' && raw['length'] > 0) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'unset' };
}

function readEvents(state: Record<string, unknown>): readonly Record<string, unknown>[] {
  const raw = state['_events'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord);
}

function eventType(event: Record<string, unknown>): string | undefined {
  const t = event['type'];
  return typeof t === 'string' ? t : undefined;
}

interface ReviewSummary {
  readonly hasEntries: boolean;
  readonly allPassed: boolean;
  readonly anyFailed: boolean;
  /**
   * The full `allReviewsPassed` obligation: all recognized review statuses passed, and every required dimension is present.
   * The HIGH-tier mutation gates must also hold.
   * It is stronger than {@link ReviewSummary.allPassed}, the `reviewPassed` rule of the debug track.
   */
  readonly requiredSatisfied: boolean;
}

function statusOf(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const raw = entry['status'] ?? entry['verdict'];
  return typeof raw === 'string' ? raw.toLowerCase() : undefined;
}

/**
 * Copy of `collectReviewStatuses` in `guards.ts`: flat `{status}` or `{verdict}` entries, the `{passed: boolean}` shape, and one nesting level.
 * An entry with none of these shapes is skipped, as legacy skips it.
 */
function collectReviewStatuses(
  reviews: Record<string, unknown>,
): readonly string[] {
  const statuses: string[] = [];
  const push = (entry: Record<string, unknown>): boolean => {
    const status = statusOf(entry);
    if (status !== undefined) {
      statuses.push(status);
      return true;
    }
    if (typeof entry['passed'] === 'boolean') {
      statuses.push(entry['passed'] === true ? 'passed' : 'failed');
      return true;
    }
    return false;
  };
  for (const value of Object.values(reviews)) {
    if (!isRecord(value)) continue;
    if (push(value)) continue;
    for (const sub of Object.values(value)) {
      if (isRecord(sub)) push(sub);
    }
  }
  return statuses;
}

/**
 * Copy of Check 1 of `allReviewsPassed`.
 * A required dimension is present only as an own, safe, object key with a status, a verdict, or a `passed` boolean.
 * An empty `{}` counts as missing. Otherwise the status collector skips it and the gate passes with nothing verified.
 */
function hasMissingRequiredDimension(
  reviews: Record<string, unknown>,
  spec: RequiredReviewsSpec,
): boolean {
  if (spec.kind === 'unset') return false;
  if (spec.kind === 'unsatisfiable') return true;
  for (const key of spec.keys) {
    if (UNSAFE_KEYS.has(key)) return true;
    if (!Object.prototype.hasOwnProperty.call(reviews, key)) return true;
    const entry = reviews[key];
    if (!isRecord(entry)) return true;
    const hasStatus = statusOf(entry) !== undefined;
    const hasLegacyPassed = typeof entry['passed'] === 'boolean';
    if (!hasStatus && !hasLegacyPassed) return true;
  }
  return false;
}

/**
 * Copy of Checks 4a and 4b of `allReviewsPassed`, the HIGH-tier mutation gates.
 * Each check applies only under an injected `block` mode and its own valid injected limit.
 * Check 4a tests the mutation score, and it blocks on a degraded run or a non-finite score.
 * Check 4b tests the NoCoverage budget, and it blocks on a missing or invalid NoCoverage count.
 * A `skipped` dimension that is not degraded blocks neither check.
 *
 * @returns `true` when enforcement blocks.
 */
function mutationEnforcementBlocks(
  state: Record<string, unknown>,
  reviews: Record<string, unknown>,
): boolean {
  if (state['_mutationEnforcement'] !== 'block') return false;
  const rawDim = reviews['mutation-adequacy'];
  const dim = isRecord(rawDim) ? rawDim : undefined;

  const threshold = state['_mutationThreshold'];
  if (typeof threshold === 'number' && Number.isFinite(threshold)) {
    if (dim?.['degraded'] === true) return true;
    const score = dim?.['mutationScore'];
    if (dim !== undefined && dim['skipped'] !== true && typeof score === 'number') {
      if (!Number.isFinite(score)) return true;
      if (score < threshold) return true;
    }
  }

  const budget = state['_maxNoCoverage'];
  if (typeof budget === 'number' && Number.isInteger(budget) && budget >= 0) {
    if (dim !== undefined && dim['skipped'] !== true && dim['degraded'] !== true) {
      const noCoverage = dim['noCoverage'];
      if (
        typeof noCoverage !== 'number' ||
        !Number.isInteger(noCoverage) ||
        noCoverage < 0
      ) {
        return true;
      }
      if (noCoverage > budget) return true;
    }
  }

  return false;
}

/**
 * Summarize the reviews of a state.
 * `allPassed` is false for an empty set of recognized statuses (Check 2) and for any status that did not pass (Check 3).
 */
function summarizeReviews(state: Record<string, unknown>): ReviewSummary {
  const reviews = state['reviews'];
  if (!isRecord(reviews)) {
    return {
      hasEntries: false,
      allPassed: false,
      anyFailed: false,
      requiredSatisfied: false,
    };
  }
  const statuses = collectReviewStatuses(reviews);
  const anyFailed = statuses.some((s) => FAILED_STATUSES.has(s));
  const allPassed =
    statuses.length > 0 && statuses.every((s) => PASSED_STATUSES.has(s));

  const requiredSpec = readRequiredReviews(state['_requiredReviews']);
  const missingRequired = hasMissingRequiredDimension(reviews, requiredSpec);
  const requiredSatisfied =
    allPassed && !missingRequired && !mutationEnforcementBlocks(state, reviews);

  return {
    hasEntries: statuses.length > 0,
    allPassed,
    anyFailed,
    requiredSatisfied,
  };
}

interface TaskSummary {
  readonly count: number;
  readonly allComplete: boolean;
}

function summarizeTasks(state: Record<string, unknown>): TaskSummary {
  const tasks = state['tasks'];
  if (!Array.isArray(tasks)) return { count: 0, allComplete: false };
  const count = tasks.length;
  const allComplete =
    count > 0 && tasks.every((t) => isRecord(t) && t['status'] === 'complete');
  return { count, allComplete };
}

function eventDataHasWorktree(event: Record<string, unknown>): boolean {
  const data = event['data'];
  if (!isRecord(data)) return false;
  return nonEmptyString(data['worktree']) || nonEmptyString(data['worktreePath']);
}

function lastTaskCompletedIndex(
  events: readonly Record<string, unknown>[],
): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev !== undefined && eventType(ev) === 'task.completed') return i;
  }
  return -1;
}

function mergePendingEntryReady(
  events: readonly Record<string, unknown>[],
): boolean {
  const idx = lastTaskCompletedIndex(events);
  if (idx < 0) return false;
  const ev = events[idx];
  return ev !== undefined && eventDataHasWorktree(ev);
}

function mergePendingExitReady(
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
): boolean {
  const orchestratorPhase = readPath(state, 'mergeOrchestrator.phase');
  if (
    typeof orchestratorPhase === 'string' &&
    TERMINAL_MERGE_ORCHESTRATOR_PHASES.has(orchestratorPhase)
  ) {
    return true;
  }
  const idx = lastTaskCompletedIndex(events);
  const scanFrom = idx < 0 ? 0 : idx + 1;
  for (let i = scanFrom; i < events.length; i += 1) {
    const ev = events[i];
    const t = ev === undefined ? undefined : eventType(ev);
    if (t !== undefined && TERMINAL_MERGE_EVENTS.has(t)) return true;
  }
  return false;
}

/** True when no team was spawned (subagent-only mode), or when a team disbanded. */
function teamDisbandedOk(
  events: readonly Record<string, unknown>[],
): boolean {
  let spawned = false;
  let disbanded = false;
  for (const ev of events) {
    const t = eventType(ev);
    if (t === 'team.spawned') spawned = true;
    if (t === 'team.disbanded') disbanded = true;
  }
  return !spawned || disbanded;
}

/**
 * Project a legacy workflow state into the closed edge-condition fact vocabulary. Total and pure.
 * Boolean, counter, and routing-selector facts are definite: an absent signal is `false`, `0`, or a default, as the legacy guards coerce it.
 * Thus `factEquals` gives `false`, not `indeterminate`, and the shadow matches every sound legacy verdict.
 * Presence facts appear only when present.
 *
 * An artifact fact needs a trimmed non-empty string, the rule of `isTypedArtifactReference` in `guards.ts`.
 * This module cannot import `guards.ts`, so `legacy-guard-parity.test.ts` keeps the two copies in step.
 * The synthesis policy defaults to `'on-request'`, because an empty sentinel deadlocks the default oneshot flow.
 * `planReview.revisionsExhausted` uses the injected cap, so the IR has one authority for the cap.
 */
export function projectStateToFacts(
  state: Record<string, unknown>,
): EdgeConditionFacts {
  const fields: Record<string, string | number | boolean> = {};
  const events = readEvents(state);
  const eventTypes = events
    .map(eventType)
    .filter((t): t is string => t !== undefined);

  const addPresent = (fact: string, value: unknown): void => {
    if (nonEmptyString(value)) fields[fact] = value;
    else if (value !== undefined && value !== null) fields[fact] = '<present>';
  };

  const addArtifactReference = (fact: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) fields[fact] = value;
  };

  addArtifactReference('artifacts.plan', readPath(state, 'artifacts.plan'));
  const rawPlan = readPath(state, 'artifacts.plan');
  fields['artifacts.planNonEmpty'] =
    typeof rawPlan === 'string' && rawPlan.trim().length > 0;
  addArtifactReference('plan', readPath(state, 'plan'));
  addPresent('artifacts.pr', readPath(state, 'artifacts.pr'));
  addPresent('synthesis.prUrl', readPath(state, 'synthesis.prUrl'));
  addArtifactReference('artifacts.rca', readPath(state, 'artifacts.rca'));
  addArtifactReference('artifacts.fixDesign', readPath(state, 'artifacts.fixDesign'));
  addArtifactReference('artifacts.report', readPath(state, 'artifacts.report'));
  addPresent('triage.symptom', readPath(state, 'triage.symptom'));
  addPresent(
    'explore.scopeAssessment',
    readPath(state, 'explore.scopeAssessment') ?? readPath(state, 'scopeAssessment'),
  );
  addPresent('resolution.commitSha', readPath(state, 'resolution.commitSha'));
  addPresent('synthesis.lastError', readPath(state, 'synthesis.lastError'));

  const track = readPath(state, 'track');
  fields['track'] = typeof track === 'string' ? track : '';
  fields['oneshot.synthesisPolicy'] = readSynthesisPolicy(state);

  fields['planReview.approved'] = isTrue(readPath(state, 'planReview.approved'));
  fields['planReview.gapsFound'] = isTrue(readPath(state, 'planReview.gapsFound'));
  fields['validation.testsPass'] = isTrue(readPath(state, 'validation.testsPass'));
  fields['validation.docsUpdated'] = isTrue(
    readPath(state, 'validation.docsUpdated'),
  );
  fields['implementation.complete'] = isTrue(
    readPath(state, 'implementation.complete'),
  );
  fields['unblocked'] = isTrue(readPath(state, 'unblocked'));
  fields['synthesis.requested'] = isTrue(readPath(state, 'synthesis.requested'));
  fields['investigation.escalate'] = isTrue(
    readPath(state, 'investigation.escalate'),
  );
  fields['resolution.directPush'] = isTrue(readPath(state, 'resolution.directPush'));
  fields['cleanup.mergeVerified'] = isTrue(readPath(state, '_cleanup.mergeVerified'));

  const tasks = summarizeTasks(state);
  fields['tasks.count'] = tasks.count;
  fields['tasks.allComplete'] = tasks.allComplete;

  const reviews = summarizeReviews(state);
  fields['reviews.allPassed'] = reviews.allPassed;
  fields['reviews.anyFailed'] = reviews.anyFailed;
  fields['reviews.requiredSatisfied'] = reviews.requiredSatisfied;

  fields['mergePending.entryReady'] = mergePendingEntryReady(events);
  fields['mergePending.exitReady'] = mergePendingExitReady(state, events);
  fields['team.disbandedOk'] = teamDisbandedOk(events);

  const revisionCount = readNumber(readPath(state, 'planReview.revisionCount'));
  const maxPlanRevisions = readMaxPlanRevisions(state);
  fields['planReview.revisionCount'] = revisionCount;
  fields['policy.maxPlanRevisions'] = maxPlanRevisions;
  fields['planReview.revisionsExhausted'] = revisionCount >= maxPlanRevisions;

  fields['synthesis.retryCount'] = readNumber(
    readPath(state, 'synthesis.retryCount'),
  );
  const sources = readPath(state, 'artifacts.sources');
  fields['artifacts.sources.count'] = Array.isArray(sources) ? sources.length : 0;

  return { fields, events: eventTypes };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestOf(value: string): ContentDigestV1 {
  return ContentDigestV1Schema.parse({
    algorithm: 'sha256',
    value: sha256Hex(value),
  });
}

/** A deterministic, content-addressed digest of the projected facts. */
export function factsDigest(facts: EdgeConditionFacts): ContentDigestV1 {
  const canonical = JSON.stringify({
    fields: Object.fromEntries(
      Object.entries(facts.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    events: [...facts.events].sort(),
  });
  return digestOf(canonical);
}

/**
 * The raw admission proof facts in the event log of a legacy state.
 * Producers such as the gate runner write `admission.evidence-recorded` with their own identity and `createdAt`.
 * The set handler hydrates the log onto `state._events` before a guarded transition, so the facts reach this module.
 * The legacy authority has no evidence store, so a requirement that no producer claims uses the derived attestation.
 */
export interface RecordedAdmissionLedger {
  /** `admission.evidence-recorded` payloads, unparsed (the selector diagnoses). */
  readonly evidence: readonly unknown[];
  /** `admission.contradiction-recorded` payloads, unparsed. */
  readonly contradictionEvents: readonly unknown[];
  /** Parsed `admission.waiver-recorded` lifecycle facts. */
  readonly waivers: readonly WaiverProvenanceV1[];
}

/** A state whose log carries no admission proof facts at all. */
export const EMPTY_RECORDED_LEDGER: RecordedAdmissionLedger = Object.freeze({
  evidence: Object.freeze([]),
  contradictionEvents: Object.freeze([]),
  waivers: Object.freeze([]),
});

/**
 * The envelope keys that `hydrateEventsFromStore` adds: it writes `{ type, timestamp, ...data, metadata: data }`.
 * The payload comes from `metadata` or from the entry without these keys, because the strict proof schemas reject the envelope.
 */
const EVENT_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'type',
  'timestamp',
  'metadata',
]);

function eventPayload(entry: Record<string, unknown>): unknown {
  const metadata = entry['metadata'];
  if (isRecord(metadata)) return metadata;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!EVENT_ENVELOPE_KEYS.has(key)) payload[key] = value;
  }
  return payload;
}

/**
 * Project the admission proof facts from the hydrated event log of a legacy state. Total and pure.
 * A state without `_events` gives the empty ledger, so each requirement falls back to the derived attestation.
 * A waiver fact that fails its schema is dropped. Thus it grants nothing, which fails closed.
 */
export function projectRecordedAdmissionFacts(
  state: Record<string, unknown>,
): RecordedAdmissionLedger {
  const evidence: unknown[] = [];
  const contradictionEvents: unknown[] = [];
  const waivers: WaiverProvenanceV1[] = [];

  for (const entry of readEvents(state)) {
    switch (eventType(entry)) {
      case ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED:
        evidence.push(eventPayload(entry));
        break;
      case ADMISSION_EVENT_TYPES.CONTRADICTION_RECORDED:
        contradictionEvents.push(eventPayload(entry));
        break;
      case ADMISSION_EVENT_TYPES.WAIVER_RECORDED: {
        const payload = eventPayload(entry);
        const parsed = WaiverProvenanceV1Schema.safeParse(
          isRecord(payload) ? payload['provenance'] : undefined,
        );
        if (parsed.success) waivers.push(parsed.data);
        break;
      }
      default:
        break;
    }
  }

  return Object.freeze({
    evidence: Object.freeze(evidence),
    contradictionEvents: Object.freeze(contradictionEvents),
    waivers: Object.freeze(waivers),
  });
}

/** The ledger after `selectEvidence`: what adjudication judges. */
export interface ResolvedAdmissionLedger {
  /** Canonical ACTIVE evidence (superseded / invalid chains already excluded). */
  readonly activeEvidence: readonly AdmissionEvidenceV1[];
  /** Contradictions detected by `selectEvidence` plus recorded ones. */
  readonly contradictions: readonly EvidenceContradiction[];
  /** Waiver lifecycle facts from the recorded ledger. */
  readonly waivers: readonly WaiverProvenanceV1[];
  /**
   * Every requirement id that a recorded fact claims. The recorded facts govern a claimed requirement, even when selection excluded all of them.
   * Otherwise a derived attestation hides a broken proof chain.
   */
  readonly claimedRequirementIds: ReadonlySet<string>;
  /** Selector diagnostics (malformed / duplicate / cyclic records). */
  readonly diagnostics: readonly EvidenceSelectionDiagnostic[];
}

const EMPTY_RESOLVED_LEDGER: ResolvedAdmissionLedger = Object.freeze({
  activeEvidence: Object.freeze([]),
  contradictions: Object.freeze([]),
  waivers: Object.freeze([]),
  claimedRequirementIds: Object.freeze(new Set<string>()),
  diagnostics: Object.freeze([]),
});

/** Best-effort read of the requirement a raw evidence payload claims. */
function claimedRequirementId(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  const evidence = candidate['evidence'];
  if (!isRecord(evidence)) return undefined;
  const requirementId = evidence['requirementId'];
  return typeof requirementId === 'string' ? requirementId : undefined;
}

/**
 * Run `selectEvidence` over a recorded ledger.
 * Two active records that disagree on one scope (requirement, subject, attempt, policy) give a contradiction.
 * `evaluatePolicy` then denies the requirement as `contradictory`, so arrival order does not pick a winner.
 */
export function resolveRecordedLedger(
  ledger: RecordedAdmissionLedger,
): ResolvedAdmissionLedger {
  if (
    ledger.evidence.length === 0 &&
    ledger.contradictionEvents.length === 0 &&
    ledger.waivers.length === 0
  ) {
    return EMPTY_RESOLVED_LEDGER;
  }

  const selection = selectEvidence({
    evidence: ledger.evidence,
    contradictionEvents: ledger.contradictionEvents,
  });
  const claimed = new Set<string>();
  for (const candidate of ledger.evidence) {
    const requirementId = claimedRequirementId(candidate);
    if (requirementId !== undefined) claimed.add(requirementId);
  }

  return Object.freeze({
    activeEvidence: Object.freeze(
      selection.activeEvidence.map((record) => record.evidence),
    ),
    contradictions: selection.contradictions,
    waivers: ledger.waivers,
    claimedRequirementIds: claimed,
    diagnostics: selection.diagnostics,
  });
}

/** Project + select in one step, from a legacy state's own event log. */
function ledgerForState(
  state: Record<string, unknown>,
): ResolvedAdmissionLedger {
  return resolveRecordedLedger(projectRecordedAdmissionFacts(state));
}

/**
 * The source of the evidence for a requirement.
 * `recorded`: proof facts from the event log governed it. `derived`: no producer claimed it, so the projection attested it.
 * `none`: the edge has no obligation.
 */
export type EvidenceProvenanceSource =
  | 'recorded'
  | 'derived'
  | 'none';

/** The genuine admission records translated from a single edge + legacy state. */
export interface EdgeAdmissionTranslation {
  readonly requirements: readonly AdmissionRequirementV1[];
  readonly evidence: readonly AdmissionEvidenceV1[];
  readonly obligations: ResolvedRequirements;
  /**
   * The three-valued evidence-presence probe outcome for the obligation, or
   * `null` for a `none` obligation (pure routing / bounded-loop / universal).
   */
  readonly presence: EdgeConditionOutcome | null;
  /** Whether a producer recorded the evidence or the translation derived it. */
  readonly evidenceProvenance: EvidenceProvenanceSource;
  /** Contradictions governing this edge's requirements. */
  readonly contradictions: readonly EvidenceContradiction[];
  /** Waiver lifecycle facts offered against this edge's requirements. */
  readonly waivers: readonly WaiverProvenanceV1[];
}

function obligationsFor(waivable: boolean): ResolvedRequirements {
  return Object.freeze({
    gates: [],
    minimumApprovals: 0,
    minimumCorroboratingSources: 0,
    waivable,
  });
}

/** An edge with no obligation: nothing to discharge, so nothing to waive. */
const NO_OBLIGATIONS: ResolvedRequirements = obligationsFor(false);

/**
 * A gate obligation is waivable by an authorized, scoped, unexpired waiver.
 * `evaluatePolicy` keeps the failure in `recordedFailures` with `waived: true`, so an audit still sees the gate that did not pass.
 */
const GATE_OBLIGATIONS: ResolvedRequirements = obligationsFor(true);

/** An approval obligation is not waivable, because a waiver for a required human approval makes the approval decorative. */
const APPROVAL_OBLIGATIONS: ResolvedRequirements = obligationsFor(false);

/**
 * Build the phase-attempt evidence subject through the schema, so a malformed subject throws at construction.
 * The digest addresses the subject identity, not the fact projection, so an external producer can name the attempt.
 * The digest of the facts goes on `contentDigest`.
 */
function subjectFor(phaseAttemptId: string): EvidenceSubjectV1 {
  const candidate: unknown = {
    kind: 'phase-attempt',
    phaseAttemptId,
    digest: digestOf(`phase-attempt|${phaseAttemptId}`),
  };
  return EvidenceSubjectV1Schema.parse(candidate);
}

/**
 * The admission scope of one edge obligation: the requirement id, the phase attempt, and the subject that a record must name.
 * Recorded evidence governs only a requirement that it names. {@link edgeAdmissionScope} is exported so a producer can compute this scope.
 */
export interface EdgeAdmissionScope {
  readonly requirementId: string;
  readonly phaseAttemptId: string;
  readonly subject: EvidenceSubjectV1;
  /** The policy the translation adjudicates the obligation under. */
  readonly policyId: string;
  readonly policyDigest: ContentDigestV1;
}

/** The admission scope of `edge`, or `undefined` for a `none` obligation. */
export function edgeAdmissionScope(
  edge: WorkflowEdgeIR,
): EdgeAdmissionScope | undefined {
  const obligation = edge.obligation;
  if (obligation.kind === 'none') return undefined;
  const key = edgeKey(edge.workflowType, edge.from, edge.to);
  const phaseAttemptId = `pa:${key}`;
  return Object.freeze({
    requirementId:
      obligation.kind === 'gate'
        ? `req:gate:${obligation.gateId}:${key}`
        : `req:approval:${obligation.approvalClass}:${key}`,
    phaseAttemptId,
    subject: subjectFor(phaseAttemptId),
    policyId: TRANSLATION_POLICY_ID,
    policyDigest: digestOf(TRANSLATION_POLICY_ID),
  });
}

/**
 * Translate one shared-IR edge + real legacy state into genuine admission
 * requirements and evidence. `none` obligations yield an empty requirement set
 * (an unconditional admission `allow`).
 */
export function translateEdgeAdmission(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
): EdgeAdmissionTranslation {
  const facts = projectStateToFacts(state);
  return translateEdgeAdmissionFromFacts(edge, facts, ctx, ledgerForState(state));
}

/**
 * Translate against a fact projection that the caller already computed.
 * The scope comes from {@link edgeAdmissionScope}, which is exported for producers.
 * A producer that uses it names the same requirement that this function judges.
 */
export function translateEdgeAdmissionFromFacts(
  edge: WorkflowEdgeIR,
  facts: EdgeConditionFacts,
  ctx: TranslationContext,
  ledger: ResolvedAdmissionLedger = EMPTY_RESOLVED_LEDGER,
): EdgeAdmissionTranslation {
  const obligation = edge.obligation;
  if (obligation.kind === 'none') {
    return {
      requirements: [],
      evidence: [],
      obligations: NO_OBLIGATIONS,
      presence: null,
      evidenceProvenance: 'none',
      contradictions: [],
      waivers: [],
    };
  }

  const key = edgeKey(edge.workflowType, edge.from, edge.to);
  const scope = edgeAdmissionScope(edge);
  if (scope === undefined) throw new Error('obligation without an admission scope');
  const fdigest = factsDigest(facts);
  const presence = evaluateEdgeCondition(obligation.presence, facts);

  if (obligation.kind === 'gate') {
    return translateGate(obligation, key, scope, fdigest, presence, ctx, ledger);
  }
  return translateApproval(obligation, key, scope, fdigest, presence, ctx, ledger);
}

/**
 * The evidence for a requirement, and its source.
 * Recorded facts govern a requirement that they claim, even when selection left nothing active.
 * In that case the evidence is empty and the requirement denies as `missing`, which fails closed.
 */
function evidenceForRequirement(
  requirementId: string,
  ledger: ResolvedAdmissionLedger,
  derive: () => readonly AdmissionEvidenceV1[],
): {
  readonly evidence: readonly AdmissionEvidenceV1[];
  readonly provenance: EvidenceProvenanceSource;
} {
  if (ledger.claimedRequirementIds.has(requirementId)) {
    return {
      evidence: ledger.activeEvidence.filter(
        (record) => record.requirementId === requirementId,
      ),
      provenance: 'recorded',
    };
  }
  return { evidence: derive(), provenance: 'derived' };
}

/** The contradictions and waivers that bear on one requirement id. */
function scopedLedger(
  requirementId: string,
  ledger: ResolvedAdmissionLedger,
): {
  readonly contradictions: readonly EvidenceContradiction[];
  readonly waivers: readonly WaiverProvenanceV1[];
} {
  return {
    contradictions: ledger.contradictions.filter(
      (contradiction) => contradiction.requirementId === requirementId,
    ),
    waivers: ledger.waivers,
  };
}

function translateGate(
  obligation: Extract<EdgeObligation, { kind: 'gate' }>,
  key: string,
  scope: EdgeAdmissionScope,
  fdigest: ContentDigestV1,
  presence: EdgeConditionOutcome,
  ctx: TranslationContext,
  ledger: ResolvedAdmissionLedger,
): EdgeAdmissionTranslation {
  const { requirementId, phaseAttemptId, subject } = scope;
  const requirement = AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId,
    phaseAttemptId,
    subject,
    kind: 'gate-evidence',
    gateId: obligation.gateId,
  });

  const derive = (): readonly AdmissionEvidenceV1[] => {
    if (presence !== 'true' && presence !== 'indeterminate') return [];
    const verdict = presence === 'true' ? 'pass' : 'indeterminate';
    return [
      AdmissionEvidenceV1Schema.parse({
        contractVersion: '1.0',
        evidenceId: `ev:gate:${obligation.gateId}:${key}`,
        requirementId,
        phaseAttemptId,
        subject,
        producer: {
          producerId: TRANSLATION_PRODUCER_ID,
          providerRef: TRANSLATION_PROVIDER_REF,
          providerVersion: TRANSLATION_PROVIDER_VERSION,
          invocationId: `inv:${key}`,
        },
        policyId: TRANSLATION_POLICY_ID,
        policyDigest: digestOf(TRANSLATION_POLICY_ID),
        contentDigest: digestOf(`gate|${obligation.gateId}|${verdict}|${fdigest.value}`),
        createdAt: ctx.evaluatedAt,
        kind: 'gate',
        verdict,
      }),
    ];
  };

  const { evidence, provenance } = evidenceForRequirement(
    requirementId,
    ledger,
    derive,
  );

  return {
    requirements: [requirement],
    evidence,
    obligations: GATE_OBLIGATIONS,
    presence,
    evidenceProvenance: provenance,
    ...scopedLedger(requirementId, ledger),
  };
}

/** An approval is two-valued, so a presence that is not `true` derives no approval and the requirement fails closed. */
function translateApproval(
  obligation: Extract<EdgeObligation, { kind: 'approval' }>,
  key: string,
  scope: EdgeAdmissionScope,
  fdigest: ContentDigestV1,
  presence: EdgeConditionOutcome,
  ctx: TranslationContext,
  ledger: ResolvedAdmissionLedger,
): EdgeAdmissionTranslation {
  const { requirementId, phaseAttemptId, subject } = scope;
  const requirement = AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId,
    phaseAttemptId,
    subject,
    kind: 'approval',
    approvalClass: obligation.approvalClass,
    minimumApprovals: obligation.minimumApprovals,
  });

  const derive = (): readonly AdmissionEvidenceV1[] => {
    if (presence !== 'true') return [];
    return [
      AdmissionEvidenceV1Schema.parse({
        contractVersion: '1.0',
        evidenceId: `ev:approval:${obligation.approvalClass}:${key}`,
        requirementId,
        phaseAttemptId,
        subject,
        producer: {
          producerId: TRANSLATION_PRODUCER_ID,
          providerRef: TRANSLATION_PROVIDER_REF,
          providerVersion: TRANSLATION_PROVIDER_VERSION,
          invocationId: `inv:${key}`,
        },
        policyId: TRANSLATION_POLICY_ID,
        policyDigest: digestOf(TRANSLATION_POLICY_ID),
        contentDigest: digestOf(
          `approval|${obligation.approvalClass}|approved|${fdigest.value}`,
        ),
        createdAt: ctx.evaluatedAt,
        kind: 'approval',
        verdict: 'approved',
        attributedTo: {
          principalKind: 'service',
          principalId: TRANSLATION_PRODUCER_ID,
          role: 'legacy-approval-projection',
        },
      }),
    ];
  };

  const { evidence, provenance } = evidenceForRequirement(
    requirementId,
    ledger,
    derive,
  );

  return {
    requirements: [requirement],
    evidence,
    obligations: APPROVAL_OBLIGATIONS,
    presence,
    evidenceProvenance: provenance,
    ...scopedLedger(requirementId, ledger),
  };
}

/** Options shared by the edge-adjudication entry points. */
export interface EdgeAdjudicationOptions {
  /**
   * The edges that the route candidates come from. The default is {@link BUILT_IN_WORKFLOW_IR}.
   * A workflow outside the built-in IR must pass its topology. Otherwise the edge is its only candidate, and multi-match and blocking cannot apply.
   */
  readonly topology?: readonly WorkflowEdgeIR[];
}

/**
 * The route candidates for the source phase of `edge`, in declaration order, which is the priority order.
 * The route condition of `edge` replaces a same-keyed copy in `topology`. When `topology` lacks `edge`, it goes last.
 * A source phase with no entry in `topology` makes `edge` the only candidate.
 */
function outboundRouteCandidates(
  edge: WorkflowEdgeIR,
  topology: readonly WorkflowEdgeIR[],
): readonly EdgeCandidate[] {
  const key = edgeKey(edge.workflowType, edge.from, edge.to);
  const self: EdgeCandidate = { edgeId: key, condition: edge.routeCondition };
  const outbound = topology.filter(
    (candidate) =>
      candidate.workflowType === edge.workflowType && candidate.from === edge.from,
  );
  if (outbound.length === 0) return [self];

  let sawSelf = false;
  const candidates = outbound.map((candidate): EdgeCandidate => {
    const candidateKey = edgeKey(
      candidate.workflowType,
      candidate.from,
      candidate.to,
    );
    if (candidateKey !== key) {
      return { edgeId: candidateKey, condition: candidate.routeCondition };
    }
    sawSelf = true;
    return self;
  });
  return sawSelf ? candidates : [...candidates, self];
}

/** The route legality of ONE edge, as decided by selection over its siblings. */
interface EdgeRouteSelection {
  /** Route legality for the queried edge under the selection. */
  readonly outcome: EdgeConditionOutcome;
  /** True when the source phase has MORE THAN ONE simultaneously-true route. */
  readonly multiMatch: boolean;
  /** Every simultaneously-legal outbound edge, in priority order. */
  readonly matchedEdgeIds: readonly string[];
}

/**
 * Decide the route legality of `edge` with `selectEdge` over the outbound candidates of its source phase.
 *  - `blocked`: a higher-priority candidate is `indeterminate`, so the edge is `indeterminate` and nothing falls through.
 *  - `no-match`: `false`, because no candidate from this phase is legal.
 *  - `selected`: `true` when the edge is one of the matching candidates.
 * A lower-priority true edge stays routable, and `multiMatch` with `matchedEdgeIds` reports the ambiguity.
 */
function selectEdgeRoute(
  edge: WorkflowEdgeIR,
  facts: EdgeConditionFacts,
  topology: readonly WorkflowEdgeIR[],
): EdgeRouteSelection {
  const key = edgeKey(edge.workflowType, edge.from, edge.to);
  const selection = selectEdge(outboundRouteCandidates(edge, topology), facts);
  if (selection.outcome === 'blocked') {
    return { outcome: 'indeterminate', multiMatch: false, matchedEdgeIds: [] };
  }
  if (selection.outcome === 'no-match') {
    return { outcome: 'false', multiMatch: false, matchedEdgeIds: [] };
  }
  return {
    outcome: selection.matchedEdgeIds.includes(key) ? 'true' : 'false',
    multiMatch: selection.multiMatch,
    matchedEdgeIds: selection.matchedEdgeIds,
  };
}

/**
 * Evaluate ONLY the admission obligation for an edge (route legality ignored).
 * `none` obligations produce an unconditional `allow`.
 */
export function evaluateEdgeAdmission(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
): PolicyEvaluation {
  const t = translateEdgeAdmission(edge, state, ctx);
  return evaluateTranslation(t, ctx);
}

/** Fold one translated edge into a policy verdict, with its requirements, evidence, contradictions, and waivers. */
function evaluateTranslation(
  t: EdgeAdmissionTranslation,
  ctx: TranslationContext,
): PolicyEvaluation {
  return evaluatePolicy({
    requirements: t.requirements,
    obligations: t.obligations,
    activeEvidence: t.evidence,
    contradictions: t.contradictions,
    waivers: t.waivers,
    authority: ctx.authority,
    evaluatedAt: ctx.evaluatedAt,
    freshnessHorizonMs: ctx.freshnessHorizonMs,
  });
}

/** The full route ∧ admission decision for one edge, ambiguity included. */
export interface EdgeAdjudication {
  /** The composed route ∧ admission verdict. */
  readonly verdict: PolicyVerdict;
  /** Route legality for this edge under selection over its full sibling set. */
  readonly route: EdgeConditionOutcome;
  /** True when the source phase has more than one route that is legal at the same time. */
  readonly multiMatch: boolean;
  /** Every outbound edge that is legal at the same time, in priority order. */
  readonly matchedEdgeIds: readonly string[];
}

/**
 * The decision for taking `edge`: route legality composed with the admission verdict.
 * A `false` route denies. An `indeterminate` route, which includes a blocked selection, fails closed to `indeterminate`.
 * A legal route defers to the admission verdict.
 * The shadow observer compares this verdict with the legacy outcome. Routing is part of it, so routing-only edges give no false disagreement.
 */
export function adjudicateEdge(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
  options: EdgeAdjudicationOptions = {},
): PolicyVerdict {
  return adjudicateEdgeDecision(edge, state, ctx, options).verdict;
}

/** {@link adjudicateEdge} with the route-selection detail: the same verdict, plus the ambiguity report. */
export function adjudicateEdgeDecision(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
  options: EdgeAdjudicationOptions = {},
): EdgeAdjudication {
  return adjudicateEdgeDecisionFromFacts(
    edge,
    projectStateToFacts(state),
    ctx,
    options.topology ?? BUILT_IN_WORKFLOW_IR,
    ledgerForState(state),
  );
}

/**
 * The decision body of {@link adjudicateEdge}, against a fact projection that the caller already computed.
 * {@link adjudicateOutboundEdges} uses it to project once for several edges.
 */
function adjudicateEdgeDecisionFromFacts(
  edge: WorkflowEdgeIR,
  facts: EdgeConditionFacts,
  ctx: TranslationContext,
  topology: readonly WorkflowEdgeIR[],
  ledger: ResolvedAdmissionLedger,
): EdgeAdjudication {
  const route = selectEdgeRoute(edge, facts, topology);
  const ambiguity = {
    multiMatch: route.multiMatch,
    matchedEdgeIds: route.matchedEdgeIds,
  };
  if (route.outcome === 'false') {
    return { verdict: 'deny', route: 'false', ...ambiguity };
  }
  if (route.outcome === 'indeterminate') {
    return { verdict: 'indeterminate', route: 'indeterminate', ...ambiguity };
  }
  const t = translateEdgeAdmissionFromFacts(edge, facts, ctx, ledger);
  return { verdict: evaluateTranslation(t, ctx).verdict, route: 'true', ...ambiguity };
}

/**
 * The projected facts that come from the event log (`_events`), not from scalar state fields.
 * The set sits beside {@link projectStateToFacts}, which computes them, as the one authority.
 * A full-state get payload has no `_events`, so for its callers an event-derived `false` is an absent fact, not a denial.
 * A caller without the log declares it, and {@link adjudicateOutboundEdges} reports the affected edges as undecidable.
 */
export const EVENT_DERIVED_FACTS: ReadonlySet<string> = Object.freeze(
  new Set([
    'mergePending.entryReady',
    'mergePending.exitReady',
    'team.disbandedOk',
  ]),
);

/** Visit every node of a compiled condition's AST (pre-order). */
function walkConditionNode(
  node: EdgeConditionNode,
  visit: (n: EdgeConditionNode) => void,
): void {
  visit(node);
  switch (node.kind) {
    case 'all':
    case 'any':
      for (const operand of node.operands) walkConditionNode(operand, visit);
      return;
    case 'not':
      walkConditionNode(node.operand, visit);
      return;
    default:
      return;
  }
}

/** True when a condition reads the event log — directly or via a derived fact. */
function conditionReadsEventLog(condition: CompiledEdgeCondition): boolean {
  let reads = false;
  walkConditionNode(condition.node, (n) => {
    if (n.kind === 'eventObserved') {
      reads = true;
      return;
    }
    if (
      (n.kind === 'factPresent' ||
        n.kind === 'factEquals' ||
        n.kind === 'counterCompare') &&
      EVENT_DERIVED_FACTS.has(n.field)
    ) {
      reads = true;
    }
  });
  return reads;
}

/**
 * True when the route condition or the presence probe of `edge` observes an event or reads one of {@link EVENT_DERIVED_FACTS}.
 * The answer comes from the IR, not from a hand-kept edge list.
 */
export function edgeDependsOnEventLog(edge: WorkflowEdgeIR): boolean {
  if (conditionReadsEventLog(edge.routeCondition)) return true;
  if (edge.obligation.kind === 'none') return false;
  return conditionReadsEventLog(edge.obligation.presence);
}

/** The admission verdict for one outbound edge, and whether it is undecidable. */
export interface OutboundEdgeVerdict {
  /** Target phase of the edge. */
  readonly to: string;
  /** Route ∧ admission verdict, or `indeterminate` when undecidable. */
  readonly verdict: PolicyVerdict;
  /**
   * `true` when the edge needs the event log and the caller declared it unavailable, so no verdict was computed.
   * Such an edge is not a denial, because the facts to deny it were not supplied.
   */
  readonly undecidable: boolean;
  /**
   * `true` when more than one outbound edge of the source phase is route-legal at the same time.
   * Always `false` for an `undecidable` edge, because its route facts were not supplied.
   */
  readonly multiMatch: boolean;
}

/** Options of {@link adjudicateOutboundEdges}. */
export interface OutboundAdmissionOptions {
  /**
   * True when `state` carries the event log (`_events`).
   * The default `false` is fail-safe: an event-gated edge is `undecidable` and stays advertised, not hidden by a false `deny`.
   */
  readonly eventLogAvailable?: boolean;
  /**
   * The topology the outbound edges and their route candidates are drawn from.
   * Defaults to {@link BUILT_IN_WORKFLOW_IR}.
   */
  readonly topology?: readonly WorkflowEdgeIR[];
}

/**
 * Adjudicate every shared-IR edge that leaves `from` for `workflowType`, keyed by target phase.
 * `next-actions-computer.ts` uses the verdicts to decide which moves to publish.
 * The state and the recorded ledger are projected once for all edges. Without `_events`, every requirement uses its derived attestation.
 * No matching IR edge gives an empty map, which means "do not gate", never deny.
 */
export function adjudicateOutboundEdges(
  workflowType: string,
  from: string,
  state: Record<string, unknown>,
  ctx: TranslationContext,
  options: OutboundAdmissionOptions = {},
): ReadonlyMap<string, OutboundEdgeVerdict> {
  const eventLogAvailable = options.eventLogAvailable ?? false;
  const topology = options.topology ?? BUILT_IN_WORKFLOW_IR;
  const verdicts = new Map<string, OutboundEdgeVerdict>();
  const outbound = topology.filter(
    (edge) => edge.workflowType === workflowType && edge.from === from,
  );
  if (outbound.length === 0) return verdicts;

  const facts = projectStateToFacts(state);
  const ledger = ledgerForState(state);
  for (const edge of outbound) {
    if (!eventLogAvailable && edgeDependsOnEventLog(edge)) {
      verdicts.set(edge.to, {
        to: edge.to,
        verdict: 'indeterminate',
        undecidable: true,
        multiMatch: false,
      });
      continue;
    }
    const decision = adjudicateEdgeDecisionFromFacts(edge, facts, ctx, topology, ledger);
    verdicts.set(edge.to, {
      to: edge.to,
      verdict: decision.verdict,
      undecidable: false,
      multiMatch: decision.multiMatch,
    });
  }
  return verdicts;
}
