// ─── P07-02 / Transition tasks 029–032 — Legacy state → admission evidence ────
//
// The REAL legacy-state → admission-evidence translation. Given an actual legacy
// workflow state object and a shared-IR edge, this module:
//
//   1. PROJECTS the legacy state into the closed edge-condition fact vocabulary
//      ({@link projectStateToFacts}) — the single place that reads legacy state
//      shapes (`artifacts.plan`, `planReview.approved`, `_events`, …);
//   2. RESOLVES the admission evidence for the edge's obligation. Recorded proof
//      facts on the workflow's own event log ({@link projectRecordedAdmissionFacts})
//      GOVERN any requirement they claim — they are selected by the P01-06
//      `selectEvidence` and their provenance (freshness, authorization,
//      well-formedness, contradictions) is EVALUATED. Only an unclaimed
//      requirement falls back to a self-derived attestation minted from the
//      projection, with real provenance (a producer, a content-addressed digest
//      of the projected facts, the evaluation instant) — never a scenario label;
//      and
//   3. ADJUDICATES the edge through the real P06-04 {@link evaluatePolicy} over
//      those requirements + evidence + contradictions + waivers, composed with
//      the P06-02 route condition.
//
// This REPLACES the P07-01 interim shadow model (scenario → evidence-presence +
// a hand-maintained `BYPASS_EVIDENCE_PRESENT` map feeding a single generic
// gate-evidence requirement). The interim model was SCENARIO-driven: it gave
// different admission verdicts to two fixtures with identical state purely from
// their `scenario` label — a tautology. This translation is STATE-driven and
// scenario-blind: identical legacy state ALWAYS yields identical admission
// evidence and therefore an identical verdict, so a shadow disagreement now
// reflects a genuine legacy/admission divergence (a P06-01 guard-soundness
// defect) rather than a proxy artifact.
//
// Independence: like `built-in-workflow-ir`, this module has NO import path to
// any legacy guard module (`guards.ts`, `hsm-definitions.ts`, `config/guards.ts`,
// `config/register.ts`). The status vocabularies and state-reading logic are
// re-derived here as data — the admission engine never calls a legacy guard.
//
// Pure: no I/O, no clock (the evaluation instant is an injected trusted input),
// no config reads.

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

// ─── Trusted translation identity ──────────────────────────────────────────────

/** The producer/approver principal the translation attributes minted evidence to. */
export const TRANSLATION_PRODUCER_ID = 'translator.legacy-state';
export const TRANSLATION_PROVIDER_REF = 'provider.legacy-state-translation';
export const TRANSLATION_PROVIDER_VERSION = '1.0';
export const TRANSLATION_POLICY_ID = 'policy.legacy-state-translation';

/**
 * The out-of-band trust grants the translation adjudication runs under.
 *
 * DR-35: the grant table used to be a CONSTANT that named exactly one principal
 * — the translator itself — so `unauthorized` could never fire and no principal
 * ever held {@link POLICY_CAPABILITY.GRANT_WAIVER}, which made the whole waiver
 * branch of `evaluatePolicy` dead code. Both are now caller-declared, because
 * both are genuine DEPLOYMENT trust decisions (P01-07): who may issue evidence
 * for an admission obligation, and who may grant a waiver against one, are
 * facts about the operator's directory, not about the record being judged.
 */
export interface TranslationTrustOptions {
  /**
   * Principals — beyond the translator itself — trusted to issue GATE evidence
   * for a translated obligation. Recorded evidence from any other producer is
   * `unauthorized` and DENIES; that is the point.
   */
  readonly gateEvidenceIssuers?: readonly string[];
  /** Principals trusted to issue APPROVAL evidence, beyond the translator. */
  readonly approvalIssuers?: readonly string[];
  /**
   * Principals trusted to GRANT a waiver. Empty by default — fail closed: with
   * no grantor, no recorded waiver can ever apply, so enabling waivers is an
   * explicit, auditable act rather than a default.
   */
  readonly waiverGrantors?: readonly string[];
}

/**
 * An authority that trusts the translation producer to issue gate AND approval
 * evidence, plus whatever additional issuers / waiver grantors the trusted
 * dispatch context declares. This is the out-of-band trust the shadow
 * adjudication runs under — it never lets a legacy state record, a recorded
 * evidence fact, or a waiver authorize itself.
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

export interface TranslationContext {
  readonly authority: PolicyAuthority;
  /** Trusted RFC3339 evaluation instant. Never `Date.now()`. */
  readonly evaluatedAt: string;
  /** Evidence older than this is stale. */
  readonly freshnessHorizonMs: number;
}

/**
 * A default translation context: trusts the translation producer (plus any
 * declared issuers / waiver grantors) and treats evidence older than an hour as
 * stale.
 *
 * DR-35 — the freshness horizon is NOT decorative. The self-derived attestation
 * the translation falls back to when nothing was recorded is stamped at
 * `evaluatedAt` and so is trivially fresh, but RECORDED evidence
 * ({@link projectRecordedAdmissionFacts}) carries the instant its producer
 * stamped, which is what the horizon is actually measured against.
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

// ─── Legacy status vocabularies (re-derived as data, not imported) ─────────────

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

// ─── State reading helpers (the only place legacy state shapes are read) ───────

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/** Navigate a dotted path through nested plain objects. Total; undefined off-path. */
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

// ─── Injected config / tier obligations (the SINGLE-AUTHORITY seam) ───────────
//
// `workflow/tools.ts` resolves `.exarchos.yml` + the risk tier and injects the
// result onto the workflow state as reserved ephemeral fields BEFORE the pure
// legacy guards run. Those fields are therefore part of the state a guard reads,
// and the projection must read them too — otherwise the admission IR would have
// to hardcode the thresholds, creating a second authority that drifts toward
// OVER-admission (it admits at the default cap while the guard denies at the
// configured one).
//
// The default constants below are RE-DERIVED AS DATA, not imported: this module
// is structurally forbidden from reaching `guards.ts`
// (`built-in-workflow-ir.structure.test.ts`). `legacy-guard-parity.test.ts`
// pins them against the real guard behavior so a re-derived default cannot
// silently diverge from the one it mirrors.

/** Mirrors `guards.ts DEFAULT_MAX_PLAN_REVISIONS` — the cap when none is injected. */
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

/**
 * The plan-revision cap the legacy `revisionsExhausted` guard would use for this
 * state: the injected `.exarchos.yml` value, falling back to the default.
 */
function readMaxPlanRevisions(state: Record<string, unknown>): number {
  const raw = state['_maxPlanRevisions'];
  return typeof raw === 'number' && Number.isFinite(raw)
    ? raw
    : DEFAULT_MAX_PLAN_REVISIONS;
}

/**
 * The oneshot synthesis policy, defaulted the way `readSynthesisPolicy` defaults
 * it: an absent OR unrecognized value collapses to `'on-request'`. Projecting a
 * missing policy as `''` (as a naive presence projection does) makes the DEFAULT
 * flow match no branch at all — every outbound edge of `implementing` denies and
 * the workflow deadlocks.
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

function readRequiredReviews(raw: unknown): RequiredReviewsSpec {
  if (Array.isArray(raw)) {
    // Legacy compares with `hasOwnProperty(reviews, key)`, which coerces a
    // non-string key to its string form — mirror that rather than dropping it.
    return raw.length === 0
      ? { kind: 'unset' }
      : {
          kind: 'keys',
          keys: raw.map((k) => (typeof k === 'string' ? k : String(k))),
        };
  }
  if (typeof raw === 'string') {
    // Legacy iterates a string CHARACTER BY CHARACTER, demanding a review
    // dimension per character — unsatisfiable in practice. Fail closed rather
    // than silently ignoring a malformed config (which would over-admit).
    return raw.length === 0 ? { kind: 'unset' } : { kind: 'unsatisfiable' };
  }
  if (isRecord(raw) && typeof raw['length'] === 'number' && raw['length'] > 0) {
    // Legacy's `for…of` throws on a non-iterable, which `executeTransition`
    // converts into a GUARD_FAILED deny. Fail closed the same way.
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

// ─── Review-status projection (re-derived from the legacy semantics) ───────────

interface ReviewSummary {
  readonly hasEntries: boolean;
  readonly allPassed: boolean;
  readonly anyFailed: boolean;
  /**
   * The FULL `allReviewsPassed` obligation: every present review passed AND
   * every injected `_requiredReviews` dimension is present-and-recognizable AND
   * the injected HIGH-tier mutation-adequacy gates hold. Strictly stronger than
   * {@link ReviewSummary.allPassed}, which is the weaker `reviewPassed`
   * (debug-track) semantics — the two legacy guards genuinely differ, so they
   * get two facts rather than one shared approximation.
   */
  readonly requiredSatisfied: boolean;
}

function statusOf(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const raw = entry['status'] ?? entry['verdict'];
  return typeof raw === 'string' ? raw.toLowerCase() : undefined;
}

/**
 * Re-derivation of `guards.ts collectReviewStatuses`: flat `{status}`/`{verdict}`
 * entries, the legacy `{passed: boolean}` shape, and one level of NESTING
 * (`reviews.A1.specReview`). An entry carrying none of these shapes is SKIPPED,
 * exactly as legacy skips it — counting it as a failure instead would make the
 * projection disagree with the guard on a shape the guard tolerates.
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
 * Re-derivation of `allReviewsPassed` Check 1: a required dimension counts as
 * PRESENT only when it is an own, non-unsafe, object-shaped key carrying a
 * recognizable status/verdict or a legacy `passed` boolean. A present-but-empty
 * `{}` is missing — it would otherwise be skipped by the status collector and
 * the gate would pass with nothing verified.
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
 * Re-derivation of `allReviewsPassed` Checks 4a/4b — the HIGH-tier mutation
 * gates. BOTH fire only under an injected `block` enforcement mode with a
 * finite/integral injected budget, and BOTH fail CLOSED on an unverifiable
 * signal (a degraded run, a non-finite score, a missing NoCoverage count). A
 * `skipped` dimension carries no score and stays advisory.
 *
 * Returns `true` when enforcement BLOCKS.
 */
function mutationEnforcementBlocks(
  state: Record<string, unknown>,
  reviews: Record<string, unknown>,
): boolean {
  if (state['_mutationEnforcement'] !== 'block') return false;
  const rawDim = reviews['mutation-adequacy'];
  const dim = isRecord(rawDim) ? rawDim : undefined;

  // Check 4a — mutation SCORE.
  const threshold = state['_mutationThreshold'];
  if (typeof threshold === 'number' && Number.isFinite(threshold)) {
    if (dim?.['degraded'] === true) return true;
    const score = dim?.['mutationScore'];
    if (dim !== undefined && dim['skipped'] !== true && typeof score === 'number') {
      if (!Number.isFinite(score)) return true;
      if (score < threshold) return true;
    }
  }

  // Check 4b — the orthogonal, deterministic NoCoverage budget.
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
  // Legacy denies on an EMPTY recognizable set (Check 2) as well as on any
  // non-passing entry (Check 3).
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

// ─── Task projection ──────────────────────────────────────────────────────────

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

// ─── Merge-pending event projection ─────────────────────────────────────────────

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
  // Vacuously satisfied when no team was ever spawned (subagent-only mode).
  return !spawned || disbanded;
}

// ─── Projection: legacy state → closed fact vocabulary ─────────────────────────

/**
 * Project a real legacy workflow state into the closed edge-condition fact
 * vocabulary. Boolean and counter facts are projected DEFINITELY (an absent
 * signal is a definite `false` / `0`, mirroring the legacy guards' boolean
 * coercion) so the shadow reproduces the legacy verdict wherever the legacy
 * decision is SOUND; presence and routing-selector facts are projected only
 * when genuinely present. Total and pure.
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

  // DR-5 (T-08): artifact fields are projected as TYPED ARTIFACT REFERENCES,
  // not bare presence. `makeArtifactGuard` on the shipped transition path now
  // requires a trimmed non-empty string (a path/URL or the contents), so a
  // `<present>` sentinel for `artifacts.plan = true` / `{}` / `'   '` would
  // make the admission engine ADMIT what the legacy authority DENIES — the
  // unsafe direction the dual-authority differential exists to catch.
  //
  // The predicate is duplicated from `guards.ts` ON PURPOSE: this module is a
  // root of the shared-IR structural-independence proof
  // (`built-in-workflow-ir.structure.test.ts`), which forbids any import path
  // — direct or transitive — from here to `workflow/guards.ts`. The two copies
  // are held in lockstep by `legacy-guard-parity.test.ts`, which compares the
  // authorities pointwise instead.
  const addArtifactReference = (fact: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) fields[fact] = value;
  };

  // ── presence facts ──
  addArtifactReference('artifacts.plan', readPath(state, 'artifacts.plan'));
  // The oneshot plan probe. `oneshotPlanSet` and `planArtifactExists` now share
  // ONE contract (a trimmed non-empty string — DR-5), but the fact is retained
  // as the explicit boolean the oneshot IR edge references, so the oneshot
  // obligation stays readable in a decision explanation.
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

  // ── routing-selector string facts (definite: absent → policy default) ──
  // Legacy track/policy guards are 2-valued (a wrong or absent selector is a
  // definite deny), so these are projected DEFINITELY — an absent selector is a
  // definite sentinel, which makes `factEquals` yield a definite `false` rather
  // than `indeterminate`. Projecting them as presence facts would leak spurious
  // `admission-indeterminate` disagreements on every routing fail case.
  const track = readPath(state, 'track');
  fields['track'] = typeof track === 'string' ? track : '';
  // The synthesis policy is NOT sentinel-defaulted: the legacy guard defaults a
  // missing/unrecognized policy to `'on-request'`, and that default is LOAD
  // BEARING — it selects the direct-commit branch. An `''` sentinel matches no
  // branch, deadlocking the DEFAULT oneshot flow.
  fields['oneshot.synthesisPolicy'] = readSynthesisPolicy(state);

  // ── boolean facts (definite) ──
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

  // ── counter facts ──
  const revisionCount = readNumber(readPath(state, 'planReview.revisionCount'));
  const maxPlanRevisions = readMaxPlanRevisions(state);
  fields['planReview.revisionCount'] = revisionCount;
  fields['policy.maxPlanRevisions'] = maxPlanRevisions;
  // The bounded-loop DECISION, resolved here against the SAME injected cap the
  // legacy `revisionsExhausted` guard reads. The IR consumes this fact instead
  // of comparing against a hardcoded constant, so there is exactly one authority
  // for the cap and it cannot drift toward over-admission on a configured repo.
  fields['planReview.revisionsExhausted'] = revisionCount >= maxPlanRevisions;

  fields['synthesis.retryCount'] = readNumber(
    readPath(state, 'synthesis.retryCount'),
  );
  const sources = readPath(state, 'artifacts.sources');
  fields['artifacts.sources.count'] = Array.isArray(sources) ? sources.length : 0;

  return { fields, events: eventTypes };
}

// ─── Content-addressed digests (genuine provenance, not a placeholder) ─────────

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

// ─── DR-35: the RECORDED admission ledger (provenance is EVALUATED) ───────────
//
// The translation used to be BOTH the producer and the judge of every piece of
// evidence it evaluated: it minted a record from the very fact projection it
// then judged, stamped `createdAt` at the evaluation instant, attributed the
// record to the one principal the authority trusted, and built the subject to
// match the requirement exactly. Five of the six sound deny reasons were
// therefore unreachable BY CONSTRUCTION — `stale`, `unauthorized`, `malformed`
// and `contradictory` could not fire, and with `waivable: false` hardcoded the
// whole waiver branch of `evaluatePolicy` was dead code.
//
// The fix is not to delete the derived attestation (the legacy authority has no
// evidence store, so the shadow differential needs SOMETHING to judge when
// nothing was recorded) — it is to stop treating it as the ONLY source. A
// workflow's own append-only event log already carries real admission proof
// facts: `admission.evidence-recorded` (written by `verbs/gates/gate-runner.ts`
// with an EXTERNAL producer identity and its own `createdAt`),
// `admission.contradiction-recorded` and `admission.waiver-recorded`.
// `workflow/tools.ts` hydrates that log onto `state._events` from the real
// event store BEFORE the guarded transition runs, so those facts reach this
// module on the shipped path without any new plumbing.
//
// When the log CLAIMS a requirement, the recorded facts GOVERN it: they are run
// through the P01-06 selector (`selectEvidence`, which is what makes
// contradiction detection live) and their provenance is evaluated by
// `evaluatePolicy` like any other third-party evidence. Only a requirement no
// producer has claimed falls back to the derived attestation.

/** The raw admission proof facts a legacy state's event log carries. */
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
 * The `_events` envelope fields `hydrateEventsFromStore` adds around the stored
 * `data` payload. It writes `{ type, timestamp, ...data, metadata: data }`, so
 * the original payload is recoverable either from `metadata` or by dropping
 * these keys — and it must be recovered, because the admission proof schemas are
 * `.strict()` and would reject the envelope as malformed.
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
 * Project the admission proof facts out of a legacy state's hydrated event log.
 *
 * Total and pure: a state with no `_events` (an affordance caller whose payload
 * was stripped at a serialization boundary) yields the empty ledger, which is
 * the fail-SAFE direction — the requirement falls back to the derived
 * attestation rather than being denied on facts nobody supplied.
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
        // A waiver fact that does not satisfy the contract grants NOTHING —
        // dropping it is fail-closed, unlike dropping an evidence fact.
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

/** The ledger after P01-06 selection — what adjudication actually judges. */
export interface ResolvedAdmissionLedger {
  /** Canonical ACTIVE evidence (superseded / invalid chains already excluded). */
  readonly activeEvidence: readonly AdmissionEvidenceV1[];
  /** Contradictions detected by `selectEvidence` plus recorded ones. */
  readonly contradictions: readonly EvidenceContradiction[];
  /** Waiver lifecycle facts; only authorized, in-scope issuances ever apply. */
  readonly waivers: readonly WaiverProvenanceV1[];
  /**
   * Every requirement id some recorded fact CLAIMS. A claimed requirement is
   * governed by the recorded facts even when selection excluded all of them —
   * otherwise a broken proof chain would be silently papered over by a
   * self-derived attestation, which is precisely the defect DR-35 closes.
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
 * Run the P01-06 selector over a recorded ledger. This is the call that makes
 * contradiction detection LIVE on the shipped admission path: two active
 * records that disagree about the same (requirement, subject, attempt, policy)
 * scope are reported as a contradiction, and `evaluatePolicy` denies the
 * requirement `contradictory` rather than letting arrival order pick a winner.
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

// ─── Evidence translation ──────────────────────────────────────────────────────

/** Where the evidence a requirement was judged on actually came from. */
export type EvidenceProvenanceSource =
  /** Recorded proof facts from the workflow's own event log governed it. */
  | 'recorded'
  /** No producer claimed the requirement; the state projection attested it. */
  | 'derived'
  /** The edge carries no obligation, so there is nothing to evidence. */
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
  /** DR-35 — whether the evidence was RECORDED by a producer or self-derived. */
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
 * A GATE obligation IS waivable — by an authorized, scoped, unexpired waiver
 * and nothing else. The failure is never rewritten: `evaluatePolicy` keeps it in
 * `recordedFailures` with `waived: true` and the waiver id, so an audit still
 * sees the gate that did not pass.
 */
const GATE_OBLIGATIONS: ResolvedRequirements = obligationsFor(true);

/**
 * An APPROVAL obligation is NOT waivable. A waiver that could stand in for a
 * required human approval would make the approval decorative — the strongest
 * point of the `waivable` order (`false ≥ true`) is the right one here.
 */
const APPROVAL_OBLIGATIONS: ResolvedRequirements = obligationsFor(false);

/**
 * Build the phase-attempt evidence subject through the SCHEMA, not through an
 * `as` assertion. An `as EvidenceSubjectV1` cast asserts a shape the compiler
 * cannot check and the runtime never validates: a malformed digest or a typo'd
 * discriminant would flow into minted evidence and only surface later (or not at
 * all). `EvidenceSubjectV1Schema.parse` takes `unknown` and either returns a
 * genuinely valid subject or throws at the point of construction.
 *
 * DR-35 — the digest content-addresses the SUBJECT IDENTITY, not the current
 * fact projection. It used to be `factsDigest(facts)`, which made the subject a
 * moving target: only the translation itself could ever produce evidence whose
 * subject matched, so `malformed` was unreachable and no external producer (or
 * waiver) could name the attempt it was certifying. A stable identity makes both
 * MATCHING and MISMATCHING genuinely possible, which is what the `malformed`
 * check is for. The state-derived digest is still carried — on `contentDigest`,
 * where it belongs.
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
 * The admission scope the translation judges ONE edge's obligation under: the
 * requirement id it declares, the phase-attempt it declares it for, and the
 * evidence subject a record must name to be well-formed against it. `undefined`
 * for a `none` obligation — there is nothing to evidence.
 *
 * This is the PRODUCER-FACING half of DR-35. Recorded evidence only governs a
 * requirement it can name, so a gate producer that wants its proof to be the
 * one admission evaluates has to be able to compute this scope. Without it the
 * recorded-evidence seam would be unusable from outside this module — a
 * consumer with no reachable producer, which is the same "built but unreached"
 * shape the change exists to close.
 */
export interface EdgeAdmissionScope {
  readonly requirementId: string;
  readonly phaseAttemptId: string;
  readonly subject: EvidenceSubjectV1;
  /** The policy the translation adjudicates the obligation under. */
  readonly policyId: string;
  readonly policyDigest: ContentDigestV1;
}

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

/** Translate against a pre-computed fact projection (avoids re-projecting). */
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
  // ONE authority for the scope: the same helper external producers call, so a
  // recorded fact and the requirement it is judged against can never drift.
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
 * The evidence a requirement is judged on, and where it came from.
 *
 * DR-35 — recorded facts GOVERN a requirement they claim, even when selection
 * left nothing active (a duplicated id, a cyclic supersession chain, a
 * schema-malformed record). Falling back to a self-derived attestation there
 * would let a broken proof chain be papered over by the very component doing
 * the judging; returning the (possibly empty) recorded set instead denies
 * `missing`, which is the fail-closed answer.
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

  // An approval verdict is two-valued (approved/rejected); a non-`true` presence
  // mints no attributable approval and therefore fails closed (deny/missing).
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

// ─── DR-34: route selection over the FULL outbound candidate set ──────────────
//
// Route legality used to be decided by evaluating ONE edge's condition in
// isolation (`evaluateEdgeCondition(edge.routeCondition, facts)`). That left two
// deterministic rules of the P06-02 selector (`selectEdge`) INERT on the shipped
// path, because the only caller that ever ran the selector was the RESERVED
// `runTransitionCommand`:
//
//   * MULTI-MATCH — a source phase with two simultaneously-true outbound
//     conditions was silently resolved to whichever edge the caller happened to
//     ask about, so an ambiguous topology looked exactly like an unambiguous
//     one; and
//   * FAIL-CLOSED (DR-9) — an `indeterminate` HIGHER-priority candidate was
//     never seen, so a lower-priority edge FELL THROUGH it and was admitted
//     while the legality of the edge above it was still unknown.
//
// The candidate set is now the outbound edges of the SAME source phase, in
// declaration (= priority) order, handed to `selectEdge`. Both rules are live.

/** Options shared by the edge-adjudication entry points. */
export interface EdgeAdjudicationOptions {
  /**
   * The edge set the outbound route candidates are drawn from. Defaults to
   * {@link BUILT_IN_WORKFLOW_IR}. A caller adjudicating a workflow authored
   * OUTSIDE the built-in IR must pass its topology: without it the edge is its
   * own only candidate and BOTH selector rules above are vacuous for that
   * workflow — the precise "built but unreached" shape DR-34 exists to close.
   */
  readonly topology?: readonly WorkflowEdgeIR[];
}

/**
 * The ordered route candidates for `edge`'s source phase. `edge`'s OWN compiled
 * route condition is substituted for its key, so an authored or overridden edge
 * is decided by the condition the caller handed in rather than by a same-keyed
 * copy in `topology`; an edge whose source phase has no entry in `topology` is
 * its own only candidate.
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
 * Decide `edge`'s route legality by running the P06-02 selector over the full
 * outbound candidate set:
 *
 *   - `blocked` (a higher-priority candidate is `indeterminate`) ⇒ the queried
 *     edge is `indeterminate` too. Routing out of this phase is UNKNOWN, so no
 *     edge may fall through the unknown one (DR-9, fail closed).
 *   - `no-match` ⇒ `false` — nothing leaving this phase is legal.
 *   - `selected` ⇒ `true` iff the queried edge is one of the matching
 *     candidates. Note the selected edge is not necessarily the ONLY legal one:
 *     route legality composes with the admission verdict downstream, so a
 *     lower-priority true edge stays routable and the ambiguity is REPORTED via
 *     `multiMatch` / `matchedEdgeIds` instead of being resolved away silently.
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

// ─── Adjudication (route ∧ admission) ──────────────────────────────────────────

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

/**
 * Fold ONE translated edge into a policy verdict. Extracted so every entry point
 * threads the SAME four inputs — requirements, the recorded active evidence, the
 * detected contradictions and the offered waivers — instead of the two the
 * pre-DR-35 body passed, which silently discarded the contradiction and waiver
 * arms of `evaluatePolicy`.
 */
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
  /** DR-34 — the source phase has more than one simultaneously-legal route. */
  readonly multiMatch: boolean;
  /** DR-34 — every simultaneously-legal outbound edge, in priority order. */
  readonly matchedEdgeIds: readonly string[];
}

/**
 * The full new-model decision for taking `edge`: the composition of the P06-02
 * ROUTE legality with the P06-04 admission verdict. A `false` route denies the
 * edge (it is not structurally legal); an `indeterminate` route — including one
 * inherited from a BLOCKED selection, where a higher-priority sibling's legality
 * is unknown — fails closed to `indeterminate`; a legal route defers to the
 * admission verdict.
 *
 * This is the "admission side" the shadow runner compares against the legacy
 * transition outcome — comparing legacy-transition against admission-only would
 * spuriously flag every routing-only edge, so routing is folded in here.
 */
export function adjudicateEdge(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
  options: EdgeAdjudicationOptions = {},
): PolicyVerdict {
  return adjudicateEdgeDecision(edge, state, ctx, options).verdict;
}

/**
 * {@link adjudicateEdge} with the route-selection detail retained: the same
 * verdict, plus the DR-34 ambiguity report the bare verdict cannot carry.
 */
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
 * The same route ∧ admission composition as {@link adjudicateEdge}, against an
 * already-computed fact projection. Extracted so a caller adjudicating SEVERAL
 * edges of one state (see {@link adjudicateOutboundEdges}) projects once instead
 * of once per edge — and so both entry points share ONE decision body rather
 * than two copies that could drift.
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

// ─── DR-9: outbound-edge adjudication for affordance publication ───────────────
//
// `next-actions-computer.ts` publishes the affordances an agent is told it may
// take. Pre-DR-9 it enumerated the HSM's outbound edges and emitted one verb per
// edge from `t.guard.description` — it never evaluated a guard nor consulted
// admission, so the runtime advertised moves admission would deny. The helpers
// below are the admission-side seam that closes it: the computer passes the
// legacy state IN and asks admission for a verdict per outbound edge, instead of
// reading a static prose string. The computer stays pure — everything here is a
// pure function of (IR, state, ctx).

/**
 * The projected facts whose values are derived from the workflow EVENT LOG
 * (`_events`) rather than from scalar state fields.
 *
 * This set is declared HERE, beside {@link projectStateToFacts} — the function
 * that actually computes them — so there is exactly one authority for "which
 * facts need the event log" and a consumer cannot hold a stale copy.
 *
 * Why it matters for affordances: {@link projectStateToFacts} projects booleans
 * DEFINITELY (an absent signal is a definite `false`), which is correct for the
 * shadow differential, where the state handed in is the complete one the legacy
 * guard saw. An affordance caller may hold a state whose event log was stripped
 * at a serialization boundary (`workflow/tools.ts` removes `_events` from every
 * `handleGet` payload). For that caller an event-derived `false` is not a real
 * denial — it is an ABSENT fact wearing a definite value, and suppressing the
 * verb would hide a move the transition guard would in fact admit. Callers
 * without an event log declare so, and {@link adjudicateOutboundEdges} reports
 * the affected edges as undecidable rather than denied.
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
 * Whether deciding `edge` requires the workflow event log — i.e. its route
 * condition or its evidence-presence probe observes an event identity or reads
 * one of {@link EVENT_DERIVED_FACTS}. Pure; derived from the IR itself, never
 * from a hand-maintained edge list.
 */
export function edgeDependsOnEventLog(edge: WorkflowEdgeIR): boolean {
  if (conditionReadsEventLog(edge.routeCondition)) return true;
  if (edge.obligation.kind === 'none') return false;
  return conditionReadsEventLog(edge.obligation.presence);
}

/** The admission verdict for one outbound edge, plus why it may be unusable. */
export interface OutboundEdgeVerdict {
  /** Target phase of the edge. */
  readonly to: string;
  /** Route ∧ admission verdict, or `indeterminate` when undecidable. */
  readonly verdict: PolicyVerdict;
  /**
   * `true` when the verdict was NOT computed because the edge needs the event
   * log and the caller declared it unavailable. Such an edge must never be
   * treated as a denial — the facts to deny it were simply not supplied.
   */
  readonly undecidable: boolean;
  /**
   * DR-34 — `true` when MORE THAN ONE outbound edge of this source phase is
   * simultaneously route-legal, so the topology does not by itself determine
   * where the workflow goes next. Always `false` for an `undecidable` edge: the
   * event log the route conditions may read was not supplied, so no honest
   * ambiguity claim can be made about that selection.
   */
  readonly multiMatch: boolean;
}

export interface OutboundAdmissionOptions {
  /**
   * Whether `state` carries the workflow event log (`_events`). Defaults to
   * `false` — the fail-SAFE direction for affordance publication: a caller that
   * does not say it has the log gets `undecidable` (keep advertising) rather
   * than a spurious `deny` (silently hide a legal move) on event-gated edges.
   */
  readonly eventLogAvailable?: boolean;
  /**
   * The topology the outbound edges and their route candidates are drawn from.
   * Defaults to {@link BUILT_IN_WORKFLOW_IR}.
   */
  readonly topology?: readonly WorkflowEdgeIR[];
}

/**
 * Adjudicate every shared-IR edge leaving `from` for `workflowType`, keyed by
 * target phase. The state is projected ONCE and each edge decided against that
 * projection through the same {@link adjudicateEdge} body — which now selects
 * over the FULL outbound candidate set (DR-34), so an ambiguous or
 * indeterminate-blocked topology is reported here rather than silently
 * resolved per edge.
 *
 * Returns an EMPTY map for a workflow type with no shared IR (a custom type
 * registered via `registerWorkflowType`) — absence of an IR edge means "no
 * admission opinion", which callers must read as "do not gate", never as deny.
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
  // DR-35 — the recorded admission ledger is projected + selected ONCE for the
  // whole outbound set, exactly like `facts`. An affordance caller whose payload
  // no longer carries `_events` yields the empty ledger, so every requirement
  // falls back to its derived attestation — the same fail-SAFE direction the
  // `undecidable` arm below takes for event-gated route conditions.
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
