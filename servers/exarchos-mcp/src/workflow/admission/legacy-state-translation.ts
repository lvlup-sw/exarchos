// ─── P07-02 / Transition tasks 029–032 — Legacy state → admission evidence ────
//
// The REAL legacy-state → admission-evidence translation. Given an actual legacy
// workflow state object and a shared-IR edge, this module:
//
//   1. PROJECTS the legacy state into the closed edge-condition fact vocabulary
//      ({@link projectStateToFacts}) — the single place that reads legacy state
//      shapes (`artifacts.plan`, `planReview.approved`, `_events`, …);
//   2. MINTS genuine, schema-valid {@link AdmissionEvidenceV1} records from that
//      projection — with real provenance (a producer, a content-addressed
//      digest of the projected facts, a fresh timestamp) — never a scenario
//      label; and
//   3. ADJUDICATES the edge through the real P06-04 {@link evaluatePolicy} over
//      those requirements + evidence, composed with the P06-02 route condition.
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
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  ContentDigestV1Schema,
  EvidenceSubjectV1Schema,
  type AdmissionEvidenceV1,
  type AdmissionRequirementV1,
  type ContentDigestV1,
  type EvidenceSubjectV1,
} from './types.js';
import {
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
 * An authority that trusts the translation producer to issue gate AND approval
 * evidence. This is the out-of-band trust the shadow adjudication runs under —
 * it never lets a legacy state record authorize itself.
 */
export function createTranslationAuthority(): PolicyAuthority {
  return createCapabilityAuthority([
    {
      principalId: TRANSLATION_PRODUCER_ID,
      capabilities: [
        POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE,
        POLICY_CAPABILITY.ISSUE_APPROVAL,
      ],
    },
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
 * A default translation context: trusts the translation producer, treats the
 * evaluation instant and all minted evidence as fresh (evidence is minted at
 * `evaluatedAt`, so it is never stale under a positive horizon).
 */
export function defaultTranslationContext(
  evaluatedAt: string,
): TranslationContext {
  return {
    authority: createTranslationAuthority(),
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

// ─── Evidence minting ──────────────────────────────────────────────────────────

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
}

const NO_WAIVER_OBLIGATIONS: ResolvedRequirements = Object.freeze({
  gates: [],
  minimumApprovals: 0,
  minimumCorroboratingSources: 0,
  waivable: false,
});

/**
 * Build the phase-attempt evidence subject through the SCHEMA, not through an
 * `as` assertion. An `as EvidenceSubjectV1` cast asserts a shape the compiler
 * cannot check and the runtime never validates: a malformed digest or a typo'd
 * discriminant would flow into minted evidence and only surface later (or not at
 * all). `EvidenceSubjectV1Schema.parse` takes `unknown` and either returns a
 * genuinely valid subject or throws at the point of construction.
 */
function subjectFor(
  phaseAttemptId: string,
  digest: ContentDigestV1,
): EvidenceSubjectV1 {
  const candidate: unknown = {
    kind: 'phase-attempt',
    phaseAttemptId,
    digest,
  };
  return EvidenceSubjectV1Schema.parse(candidate);
}

/**
 * Translate one shared-IR edge + real legacy state into genuine admission
 * requirements and (minted) evidence. `none` obligations yield an empty
 * requirement set (an unconditional admission `allow`).
 */
export function translateEdgeAdmission(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
): EdgeAdmissionTranslation {
  const facts = projectStateToFacts(state);
  return translateEdgeAdmissionFromFacts(edge, facts, ctx);
}

/** Translate against a pre-computed fact projection (avoids re-projecting). */
export function translateEdgeAdmissionFromFacts(
  edge: WorkflowEdgeIR,
  facts: EdgeConditionFacts,
  ctx: TranslationContext,
): EdgeAdmissionTranslation {
  const obligation = edge.obligation;
  if (obligation.kind === 'none') {
    return {
      requirements: [],
      evidence: [],
      obligations: NO_WAIVER_OBLIGATIONS,
      presence: null,
    };
  }

  const key = edgeKey(edge.workflowType, edge.from, edge.to);
  const phaseAttemptId = `pa:${key}`;
  const fdigest = factsDigest(facts);
  const subject = subjectFor(phaseAttemptId, fdigest);
  const presence = evaluateEdgeCondition(obligation.presence, facts);

  if (obligation.kind === 'gate') {
    return translateGate(obligation, key, phaseAttemptId, subject, fdigest, presence, ctx);
  }
  return translateApproval(obligation, key, phaseAttemptId, subject, fdigest, presence, ctx);
}

function translateGate(
  obligation: Extract<EdgeObligation, { kind: 'gate' }>,
  key: string,
  phaseAttemptId: string,
  subject: EvidenceSubjectV1,
  fdigest: ContentDigestV1,
  presence: EdgeConditionOutcome,
  ctx: TranslationContext,
): EdgeAdmissionTranslation {
  const requirementId = `req:gate:${obligation.gateId}:${key}`;
  const requirement = AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId,
    phaseAttemptId,
    subject,
    kind: 'gate-evidence',
    gateId: obligation.gateId,
  });

  const evidence: AdmissionEvidenceV1[] = [];
  if (presence === 'true' || presence === 'indeterminate') {
    const verdict = presence === 'true' ? 'pass' : 'indeterminate';
    evidence.push(
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
    );
  }

  return {
    requirements: [requirement],
    evidence,
    obligations: NO_WAIVER_OBLIGATIONS,
    presence,
  };
}

function translateApproval(
  obligation: Extract<EdgeObligation, { kind: 'approval' }>,
  key: string,
  phaseAttemptId: string,
  subject: EvidenceSubjectV1,
  fdigest: ContentDigestV1,
  presence: EdgeConditionOutcome,
  ctx: TranslationContext,
): EdgeAdmissionTranslation {
  const requirementId = `req:approval:${obligation.approvalClass}:${key}`;
  const requirement = AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId,
    phaseAttemptId,
    subject,
    kind: 'approval',
    approvalClass: obligation.approvalClass,
    minimumApprovals: obligation.minimumApprovals,
  });

  const evidence: AdmissionEvidenceV1[] = [];
  // An approval verdict is two-valued (approved/rejected); a non-`true` presence
  // mints no attributable approval and therefore fails closed (deny/missing).
  if (presence === 'true') {
    evidence.push(
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
    );
  }

  return {
    requirements: [requirement],
    evidence,
    obligations: NO_WAIVER_OBLIGATIONS,
    presence,
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
  return evaluatePolicy({
    requirements: t.requirements,
    obligations: t.obligations,
    activeEvidence: t.evidence,
    authority: ctx.authority,
    evaluatedAt: ctx.evaluatedAt,
    freshnessHorizonMs: ctx.freshnessHorizonMs,
  });
}

/**
 * The full new-model decision for taking `edge`: the composition of the P06-02
 * ROUTE legality with the P06-04 admission verdict. A `false` route denies the
 * edge (it is not structurally legal); a leading `indeterminate` route fails
 * closed to `indeterminate`; a legal route defers to the admission verdict.
 *
 * This is the "admission side" the shadow runner compares against the legacy
 * transition outcome — comparing legacy-transition against admission-only would
 * spuriously flag every routing-only edge, so routing is folded in here.
 */
export function adjudicateEdge(
  edge: WorkflowEdgeIR,
  state: Record<string, unknown>,
  ctx: TranslationContext,
): PolicyVerdict {
  const facts = projectStateToFacts(state);
  const route = evaluateEdgeCondition(edge.routeCondition, facts);
  if (route === 'false') return 'deny';
  if (route === 'indeterminate') return 'indeterminate';
  const t = translateEdgeAdmissionFromFacts(edge, facts, ctx);
  return evaluatePolicy({
    requirements: t.requirements,
    obligations: t.obligations,
    activeEvidence: t.evidence,
    authority: ctx.authority,
    evaluatedAt: ctx.evaluatedAt,
    freshnessHorizonMs: ctx.freshnessHorizonMs,
  }).verdict;
}
