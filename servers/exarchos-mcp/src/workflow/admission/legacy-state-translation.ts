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
}

function statusOf(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const raw = entry['status'] ?? entry['verdict'];
  return typeof raw === 'string' ? raw.toLowerCase() : undefined;
}

function summarizeReviews(state: Record<string, unknown>): ReviewSummary {
  const reviews = state['reviews'];
  if (!isRecord(reviews)) {
    return { hasEntries: false, allPassed: false, anyFailed: false };
  }
  const entries = Object.values(reviews);
  if (entries.length === 0) {
    return { hasEntries: false, allPassed: false, anyFailed: false };
  }
  let allPassed = true;
  let anyFailed = false;
  for (const entry of entries) {
    const status = statusOf(entry);
    if (status !== undefined && FAILED_STATUSES.has(status)) anyFailed = true;
    if (status === undefined || !PASSED_STATUSES.has(status)) allPassed = false;
  }
  return { hasEntries: true, allPassed, anyFailed };
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

  // ── presence facts ──
  addPresent('artifacts.plan', readPath(state, 'artifacts.plan'));
  addPresent('plan', readPath(state, 'plan'));
  addPresent('artifacts.pr', readPath(state, 'artifacts.pr'));
  addPresent('synthesis.prUrl', readPath(state, 'synthesis.prUrl'));
  addPresent('artifacts.rca', readPath(state, 'artifacts.rca'));
  addPresent('artifacts.fixDesign', readPath(state, 'artifacts.fixDesign'));
  addPresent('artifacts.report', readPath(state, 'artifacts.report'));
  addPresent('triage.symptom', readPath(state, 'triage.symptom'));
  addPresent(
    'explore.scopeAssessment',
    readPath(state, 'explore.scopeAssessment') ?? readPath(state, 'scopeAssessment'),
  );
  addPresent('resolution.commitSha', readPath(state, 'resolution.commitSha'));
  addPresent('synthesis.lastError', readPath(state, 'synthesis.lastError'));

  // ── routing-selector string facts (definite: absent → '' sentinel) ──
  // Legacy track/policy guards are 2-valued (a wrong or absent selector is a
  // definite deny), so these are projected DEFINITELY — an absent selector is a
  // definite empty string, which makes `factEquals` yield a definite `false`
  // rather than `indeterminate`. Projecting them as presence facts would leak
  // spurious `admission-indeterminate` disagreements on every routing fail case.
  const track = readPath(state, 'track');
  fields['track'] = typeof track === 'string' ? track : '';
  const policy = readPath(state, 'oneshot.synthesisPolicy');
  fields['oneshot.synthesisPolicy'] = typeof policy === 'string' ? policy : '';

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

  fields['mergePending.entryReady'] = mergePendingEntryReady(events);
  fields['mergePending.exitReady'] = mergePendingExitReady(state, events);
  fields['team.disbandedOk'] = teamDisbandedOk(events);

  // ── counter facts ──
  fields['planReview.revisionCount'] = readNumber(
    readPath(state, 'planReview.revisionCount'),
  );
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

function subjectFor(
  phaseAttemptId: string,
  digest: ContentDigestV1,
): EvidenceSubjectV1 {
  return {
    kind: 'phase-attempt',
    phaseAttemptId,
    digest,
  } as EvidenceSubjectV1;
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
