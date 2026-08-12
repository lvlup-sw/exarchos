/**
 * DR-35 — evidence provenance is EVALUATED, not minted; waivers are REACHABLE.
 *
 * `legacy-state-translation.ts` used to be both the producer and the judge of
 * every record it evaluated. It minted evidence from the very fact projection
 * it then judged, stamped `createdAt` at the evaluation instant, attributed the
 * record to the one principal its own authority trusted, and derived the
 * subject digest from the facts so the subject always matched the requirement.
 * Four sound deny reasons were therefore unreachable BY CONSTRUCTION —
 * `stale`, `unauthorized`, `malformed`, `contradictory` — and with the
 * obligation lattice pinned to `waivable: false` and neither `contradictions`
 * nor `waivers` ever threaded into `evaluatePolicy`, the entire waiver branch
 * was dead code.
 *
 * These tests drive the assertions from the PUBLIC ROOT, because a proof that
 * calls `adjudicateEdge` (or `evaluatePolicy`) directly is exactly the vacuous
 * shape that let the defect ship:
 *
 *   - the deny tests go through `handleWorkflow({action:'transition'})` — the
 *     real composite handler, the real HSM guard, the real `GuardContext`
 *     shadow observer, a real `EventStore` and a real state dir — and assert on
 *     the DURABLE `admission.shadow-attempt` record the live path persists;
 *   - the waiver tests go through `adjudicateOutboundEdges`, the affordance
 *     root `next-actions-computer.ts` publishes from, over state hydrated by
 *     the production `hydrateEventsFromStore`.
 *
 * Nothing here is hand-mocked: the admission proof facts are appended to the
 * feature's own append-only stream exactly as `orchestrate/gate-runner.ts`
 * appends them in production, and reach the translation because
 * `workflow/tools.ts` hydrates that stream onto `state._events` before the
 * guarded transition runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adjudicateOutboundEdges,
  defaultTranslationContext,
  edgeAdmissionScope,
  evaluateEdgeAdmission,
  projectRecordedAdmissionFacts,
  resolveRecordedLedger,
  translateEdgeAdmission,
  TRANSLATION_PRODUCER_ID,
  TRANSLATION_PROVIDER_REF,
  TRANSLATION_PROVIDER_VERSION,
  type EdgeAdmissionScope,
} from './legacy-state-translation.js';
import { getEdgeIR, type WorkflowEdgeIR } from './built-in-workflow-ir.js';
import {
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  liveShadowSink,
} from './live-shadow-observer.js';
import { EventStore } from '../../events/store.js';
import { AdmissionShadowAttemptData } from '../../events/schemas.js';
import { handleWorkflow } from '../composite.js';
import { handleGet, handleSet } from '../tools.js';
import { hydrateEventsFromStore } from '../state-store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The shipped gate edge under test: `feature: plan -> plan-review`. */
const GATE_EDGE: WorkflowEdgeIR = (() => {
  const edge = getEdgeIR('feature', 'plan', 'plan-review');
  if (edge === undefined) throw new Error('feature plan -> plan-review missing');
  return edge;
})();

/** The shipped approval edge: `feature: plan-review -> delegate`. */
const APPROVAL_EDGE: WorkflowEdgeIR = (() => {
  const edge = getEdgeIR('feature', 'plan-review', 'delegate');
  if (edge === undefined) throw new Error('feature plan-review -> delegate missing');
  return edge;
})();

const GATE_SCOPE: EdgeAdmissionScope = (() => {
  const scope = edgeAdmissionScope(GATE_EDGE);
  if (scope === undefined) throw new Error('gate edge has no admission scope');
  return scope;
})();

const APPROVAL_SCOPE: EdgeAdmissionScope = (() => {
  const scope = edgeAdmissionScope(APPROVAL_EDGE);
  if (scope === undefined) throw new Error('approval edge has no admission scope');
  return scope;
})();

const digest = (value: string) => ({
  algorithm: 'sha256' as const,
  value: createHash('sha256').update(value, 'utf8').digest('hex'),
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

interface GateEvidenceOptions {
  readonly evidenceId: string;
  readonly verdict: 'pass' | 'fail' | 'indeterminate';
  readonly scope?: EdgeAdmissionScope;
  readonly requirementId?: string;
  readonly producerId?: string;
  readonly createdAt?: string;
  readonly supersedesEvidenceId?: string;
}

/**
 * One `admission.evidence-recorded` payload. Every field a producer controls is
 * a parameter — that is the whole point: the pre-DR-35 translation controlled
 * all of them itself and could therefore never be surprised by any of them.
 */
function gateEvidenceEvent(options: GateEvidenceOptions): Record<string, unknown> {
  const scope = options.scope ?? GATE_SCOPE;
  return {
    eventVersion: '1.0',
    evidence: {
      contractVersion: '1.0',
      evidenceId: options.evidenceId,
      requirementId: options.requirementId ?? scope.requirementId,
      phaseAttemptId: scope.phaseAttemptId,
      subject: scope.subject,
      producer: {
        producerId: options.producerId ?? TRANSLATION_PRODUCER_ID,
        providerRef: TRANSLATION_PROVIDER_REF,
        providerVersion: TRANSLATION_PROVIDER_VERSION,
        invocationId: `inv:${options.evidenceId}`,
      },
      policyId: scope.policyId,
      policyDigest: scope.policyDigest,
      contentDigest: digest(`gate|${options.evidenceId}|${options.verdict}`),
      createdAt: options.createdAt ?? iso(now()),
      kind: 'gate',
      verdict: options.verdict,
    },
    ...(options.supersedesEvidenceId === undefined
      ? {}
      : { supersedesEvidenceId: options.supersedesEvidenceId }),
  };
}

const WAIVER_ACTOR_ID = 'ops.release-manager';

interface WaiverOptions {
  readonly waiverId: string;
  readonly scope?: EdgeAdmissionScope;
  readonly waivedRequirementIds?: readonly string[];
  readonly expiresAt?: string;
  readonly actorId?: string;
}

/** One `admission.waiver-recorded` issuance payload. */
function waiverEvent(options: WaiverOptions): Record<string, unknown> {
  const scope = options.scope ?? GATE_SCOPE;
  return {
    eventVersion: '1.0',
    provenance: {
      contractVersion: '1.0',
      waiverId: options.waiverId,
      actor: {
        principalKind: 'operator',
        principalId: options.actorId ?? WAIVER_ACTOR_ID,
        role: 'release-manager',
      },
      authorization: {
        authorizationId: `authz:${options.waiverId}`,
        posture: 'shared-mutating',
        capabilityIds: ['capability.grant-waiver'],
        resolverVersion: '1.0',
        resolvedAt: iso(now() - 60_000),
      },
      recordedAt: iso(now() - 60_000),
      event: 'issued',
      rationale: 'plan artifact deferred to the implementation wave by release board',
      scope: { kind: 'subject', subject: scope.subject },
      subjectDigest: scope.subject.digest,
      expiresAt: options.expiresAt ?? iso(now() + DAY_MS),
      waivedRequirementIds: options.waivedRequirementIds ?? [scope.requirementId],
      policyId: scope.policyId,
      policyDigest: scope.policyDigest,
    },
  };
}

// ─── Live-path harness ───────────────────────────────────────────────────────

describe('DR-35 — recorded evidence provenance denies on the LIVE transition path', () => {
  let stateDir: string;
  let eventStore: EventStore;

  const ctx = () => ({ stateDir, eventStore, enableTelemetry: false });

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'evidence-provenance-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    liveShadowSink.clear();
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    liveShadowSink.clear();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  /**
   * Init a real feature workflow at `plan` with the plan artifact present, so
   * the LEGACY guard admits the transition. Any admission deny that follows is
   * attributable to the recorded evidence, not to the workflow being unready.
   */
  async function seedFeatureAtPlan(featureId: string): Promise<void> {
    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/plan.md' } },
      stateDir,
      eventStore,
    );
  }

  /** Append an admission proof fact to the feature's OWN append-only stream. */
  async function record(
    featureId: string,
    type: string,
    data: Record<string, unknown>,
    key: string,
  ): Promise<void> {
    await eventStore.append(
      featureId,
      { type, timestamp: new Date().toISOString(), source: 'test-producer', data },
      { idempotencyKey: `${featureId}:${key}` },
    );
  }

  /** Drive the real guarded transition and read back the durable shadow record. */
  async function transitionAndReadShadow(featureId: string) {
    const transition = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    await flushLiveShadowEvidence();
    const persisted = await eventStore.query(liveShadowEvidenceStreamId(featureId), {
      type: 'admission.shadow-attempt',
    });
    expect(persisted.length).toBeGreaterThan(0);
    const durable = AdmissionShadowAttemptData.parse(
      persisted[persisted.length - 1]!.data,
    );
    return { transition, durable };
  }

  const denyReasons = (durable: { decision: Record<string, unknown> }): string[] => {
    const decision = durable.decision as {
      outcome: string;
      unsatisfiedRequirements?: readonly { reason: string }[];
    };
    return [...(decision.unsatisfiedRequirements ?? [])].map((r) => r.reason);
  };

  // ── Control ────────────────────────────────────────────────────────────────
  //
  // The SAME workflow, the SAME transition, with NOTHING recorded. The derived
  // attestation still governs an unclaimed requirement, so admission allows.
  // Without this control every deny below could be an artefact of the harness.
  it('Admission_NoRecordedEvidence_FallsBackToDerivedAttestationAndAllows', async () => {
    const featureId = 'provenance-control';
    await seedFeatureAtPlan(featureId);

    const { transition, durable } = await transitionAndReadShadow(featureId);

    expect(transition.success).toBe(true);
    expect(durable.decision.outcome).toBe('allow');
  });

  // ── Required test: stale ───────────────────────────────────────────────────
  it('Admission_StaleEvidence_Denies', async () => {
    const featureId = 'provenance-stale';
    await seedFeatureAtPlan(featureId);

    // Well-formed and authorized, so it clears `missing`, `malformed` and
    // `unauthorized` — the ONLY thing wrong with it is its age. The pre-DR-35
    // translation stamped `createdAt` at `ctx.evaluatedAt`, which made an age
    // of anything other than zero impossible to express.
    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({
        evidenceId: 'ev:gate:plan-artifact:stale',
        verdict: 'pass',
        createdAt: iso(now() - 30 * DAY_MS),
      }),
      'stale',
    );

    const { durable } = await transitionAndReadShadow(featureId);

    expect(durable.decision.outcome).toBe('deny');
    expect(denyReasons(durable)).toContain('stale');
  });

  // ── unauthorized ───────────────────────────────────────────────────────────
  it('Admission_UnauthorizedProducerEvidence_Denies', async () => {
    const featureId = 'provenance-unauthorized';
    await seedFeatureAtPlan(featureId);

    // Fresh, well-formed, and asserting `pass` — but issued by a principal the
    // out-of-band authority does not trust to issue gate evidence. The
    // pre-DR-35 translation was its own sole producer AND granted itself
    // `ISSUE_GATE_EVIDENCE`, so no untrusted issuer could ever appear.
    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({
        evidenceId: 'ev:gate:plan-artifact:untrusted',
        verdict: 'pass',
        producerId: 'ci.external-gate-runner',
      }),
      'unauthorized',
    );

    const { durable } = await transitionAndReadShadow(featureId);

    expect(durable.decision.outcome).toBe('deny');
    expect(denyReasons(durable)).toContain('unauthorized');
  });

  // ── malformed ──────────────────────────────────────────────────────────────
  it('Admission_MalformedEvidence_Denies', async () => {
    const featureId = 'provenance-malformed';
    await seedFeatureAtPlan(featureId);

    // Claims the RIGHT requirement but carries a DIFFERENT phase attempt and
    // subject — evidence about another attempt filed against this one. The
    // pre-DR-35 translation built the subject from the same facts it judged,
    // so the subject and the requirement could not disagree.
    expect(APPROVAL_SCOPE.subject).not.toEqual(GATE_SCOPE.subject);

    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({
        evidenceId: 'ev:gate:plan-artifact:wrong-subject',
        verdict: 'pass',
        scope: APPROVAL_SCOPE,
        requirementId: GATE_SCOPE.requirementId,
      }),
      'malformed',
    );

    const { durable } = await transitionAndReadShadow(featureId);

    expect(durable.decision.outcome).toBe('deny');
    expect(denyReasons(durable)).toContain('malformed');
  });

  // ── contradictory — proves `selectEvidence` is LIVE ────────────────────────
  //
  // Nothing here records an `admission.contradiction-recorded` fact. The
  // contradiction can ONLY exist because `selectEvidence` DETECTED it: two
  // active records in one (requirement, subject, attempt, policy) scope making
  // opposite statements, neither superseding the other. If the selector were
  // not called on the wired path, `evaluateGate` would find a passing record
  // and ALLOW, because a `pass` short-circuits before `fail` is even examined.
  it('Admission_ContradictoryEvidence_Denies_ViaLiveSelectEvidence', async () => {
    const featureId = 'provenance-contradictory';
    await seedFeatureAtPlan(featureId);

    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({ evidenceId: 'ev:gate:plan-artifact:a', verdict: 'pass' }),
      'contradiction-a',
    );
    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({ evidenceId: 'ev:gate:plan-artifact:b', verdict: 'fail' }),
      'contradiction-b',
    );

    const { durable } = await transitionAndReadShadow(featureId);

    expect(durable.decision.outcome).toBe('deny');
    expect(denyReasons(durable)).toContain('contradictory');
  });

  // ── supersession — the other half of `selectEvidence` being live ───────────
  //
  // Byte-identical to the contradiction case EXCEPT for the append-only
  // supersession link. Honouring it is what turns a contradiction into a
  // single active record, so this pins that the recorded ledger is the real
  // P01-06 selection and not a naive filter over the raw facts.
  it('Admission_SupersededEvidence_IsNotActive_AndAllows', async () => {
    const featureId = 'provenance-supersede';
    await seedFeatureAtPlan(featureId);

    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({ evidenceId: 'ev:gate:plan-artifact:a', verdict: 'fail' }),
      'superseded',
    );
    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({
        evidenceId: 'ev:gate:plan-artifact:b',
        verdict: 'pass',
        supersedesEvidenceId: 'ev:gate:plan-artifact:a',
      }),
      'superseding',
    );

    const { durable } = await transitionAndReadShadow(featureId);

    expect(durable.decision.outcome).toBe('allow');
  });

  // ── failed — the recorded verdict, not the projection, decides ─────────────
  //
  // The legacy state HAS the plan artifact, so the self-derived attestation
  // would say `pass`. A trusted, fresh producer says `fail`. Recorded facts
  // govern the requirement they claim, so admission denies `failed` — the
  // translation no longer gets to overrule a producer with its own opinion.
  it('Admission_RecordedFailure_OverridesTheSelfDerivedAttestation', async () => {
    const featureId = 'provenance-failed';
    await seedFeatureAtPlan(featureId);

    await record(
      featureId,
      'admission.evidence-recorded',
      gateEvidenceEvent({ evidenceId: 'ev:gate:plan-artifact:f', verdict: 'fail' }),
      'failed',
    );

    const { durable } = await transitionAndReadShadow(featureId);

    expect(durable.decision.outcome).toBe('deny');
    expect(denyReasons(durable)).toContain('failed');
  });
});

// ─── Waivers ─────────────────────────────────────────────────────────────────

describe('DR-35 — the waiver branch is reachable and strictly scoped', () => {
  let stateDir: string;
  let eventStore: EventStore;
  const featureId = 'waiver-scope';

  const ctx = () => ({ stateDir, eventStore, enableTelemetry: false });

  /**
   * Waiver-GRANT trust is out-of-band, exactly like evidence-issuance trust:
   * the authority must be told which principals may grant. The live translation
   * context declares NO grantors, so waivers are fail-closed on the shipped
   * path until a deployment declares one.
   */
  const trusting = () =>
    defaultTranslationContext(new Date().toISOString(), {
      waiverGrantors: [WAIVER_ACTOR_ID],
    });

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'evidence-waiver-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    liveShadowSink.clear();
    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    // Deliberately NO plan artifact: the gate is genuinely unsatisfied
    // (`missing`), which is what a waiver has to rescue for the branch to mean
    // anything.
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    liveShadowSink.clear();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  async function recordWaiver(
    options: WaiverOptions & { readonly key: string },
  ): Promise<void> {
    await eventStore.append(
      featureId,
      {
        type: 'admission.waiver-recorded',
        timestamp: new Date().toISOString(),
        source: 'test-producer',
        data: waiverEvent(options),
      },
      { idempotencyKey: `${featureId}:${options.key}` },
    );
  }

  /** Real state + the production event hydration `workflow/tools.ts` performs. */
  async function liveState(): Promise<Record<string, unknown>> {
    const base = (await handleGet({ featureId }, stateDir, eventStore)).data as Record<
      string,
      unknown
    >;
    return { ...base, _events: await hydrateEventsFromStore(featureId, eventStore) };
  }

  const gateVerdict = async () => {
    const state = await liveState();
    return adjudicateOutboundEdges('feature', 'plan', state, trusting(), {
      eventLogAvailable: true,
    }).get('plan-review')?.verdict;
  };

  // ── Required test ──────────────────────────────────────────────────────────
  it('Admission_ScopedWaiver_AppliesOnlyToDeclaredSubject', async () => {
    // Baseline: the unsatisfied gate denies. If this were already `allow` the
    // waiver assertion below would prove nothing.
    expect(await gateVerdict()).toBe('deny');

    // ── A waiver naming a DIFFERENT subject rescues NOTHING. ────────────────
    expect(APPROVAL_SCOPE.subject).not.toEqual(GATE_SCOPE.subject);
    await recordWaiver({
      key: 'other-subject',
      waiverId: 'waiver:other-subject',
      scope: APPROVAL_SCOPE,
      // Names THIS requirement, but scoped to another subject: only the
      // subject check can reject it.
      waivedRequirementIds: [GATE_SCOPE.requirementId],
    });
    expect(await gateVerdict()).toBe('deny');

    // ── A waiver naming a DIFFERENT requirement rescues NOTHING. ────────────
    await recordWaiver({
      key: 'other-requirement',
      waiverId: 'waiver:other-requirement',
      waivedRequirementIds: ['req:gate:some-other-gate:feature:plan:plan-review'],
    });
    expect(await gateVerdict()).toBe('deny');

    // ── An EXPIRED waiver rescues NOTHING. ─────────────────────────────────
    await recordWaiver({
      key: 'expired',
      waiverId: 'waiver:expired',
      expiresAt: iso(now() - HOUR_MS),
    });
    expect(await gateVerdict()).toBe('deny');

    // ── A waiver from an UNTRUSTED grantor rescues NOTHING. ────────────────
    await recordWaiver({
      key: 'untrusted',
      waiverId: 'waiver:untrusted',
      actorId: 'agent.self-appointed',
    });
    expect(await gateVerdict()).toBe('deny');

    // ── The waiver that names BOTH the declared subject AND the declared
    // requirement, unexpired, from a trusted grantor, DOES apply. ───────────
    await recordWaiver({ key: 'exact', waiverId: 'waiver:plan-artifact' });
    expect(await gateVerdict()).toBe('allow');

    // ── ...and it never rewrites the failure it permitted admission despite.
    const evaluation = evaluateEdgeAdmission(GATE_EDGE, await liveState(), trusting());
    expect(evaluation.verdict).toBe('allow');
    expect(evaluation.appliedWaiverIds).toContain('waiver:plan-artifact');
    expect(evaluation.recordedFailures).toContainEqual(
      expect.objectContaining({
        requirementId: GATE_SCOPE.requirementId,
        reason: 'missing',
        waived: true,
        waiverId: 'waiver:plan-artifact',
      }),
    );
    expect(evaluation.requirementEvaluations).toContainEqual(
      expect.objectContaining({ status: 'waived', waivedReason: 'missing' }),
    );

    // ── ...and it rescues NO OTHER edge. The same log, the same trusted
    // grantor, a different source phase: the approval obligation out of
    // `plan-review` is a different requirement over a different subject and
    // stays denied. ─────────────────────────────────────────────────────────
    const elsewhere = adjudicateOutboundEdges(
      'feature',
      'plan-review',
      await liveState(),
      trusting(),
      { eventLogAvailable: true },
    );
    expect(elsewhere.get('delegate')?.verdict).toBe('deny');
  });

  it('Admission_WaiverWithoutADeclaredGrantor_IsFailClosed', async () => {
    await recordWaiver({ key: 'exact', waiverId: 'waiver:plan-artifact' });

    // The SHIPPED live context declares no waiver grantors at all. The very
    // same waiver that applies under `trusting()` grants nothing here.
    const shipped = defaultTranslationContext(new Date().toISOString());
    const state = await liveState();
    const verdict = adjudicateOutboundEdges('feature', 'plan', state, shipped, {
      eventLogAvailable: true,
    }).get('plan-review')?.verdict;

    expect(verdict).toBe('deny');
    expect(
      evaluateEdgeAdmission(GATE_EDGE, state, shipped).appliedWaiverIds,
    ).toEqual([]);
  });

  // ── `obligations.waivable` must be able to be `true` ───────────────────────
  it('Admission_GateObligationIsWaivable_ApprovalObligationIsNot', async () => {
    const state = await liveState();

    const gate = translateEdgeAdmission(GATE_EDGE, state, trusting());
    expect(gate.obligations.waivable).toBe(true);

    // The complement matters just as much: if EVERY obligation were waivable
    // we would have traded one dead branch (`waivable: false`) for another
    // (`evaluateWaiver`'s `not-waivable` rejection). A waiver standing in for
    // a required human approval would make the approval decorative.
    const approval = translateEdgeAdmission(APPROVAL_EDGE, state, trusting());
    expect(approval.obligations.waivable).toBe(false);
    expect(APPROVAL_SCOPE.requirementId).not.toBe(GATE_SCOPE.requirementId);
  });

  // ── The ledger projection itself ───────────────────────────────────────────
  it('Admission_RecordedLedger_IsProjectedFromTheWorkflowsOwnEventLog', async () => {
    await recordWaiver({ key: 'exact', waiverId: 'waiver:plan-artifact' });
    await eventStore.append(
      featureId,
      {
        type: 'admission.evidence-recorded',
        timestamp: new Date().toISOString(),
        source: 'test-producer',
        data: gateEvidenceEvent({
          evidenceId: 'ev:gate:plan-artifact:ledger',
          verdict: 'pass',
        }),
      },
      { idempotencyKey: `${featureId}:ledger` },
    );

    const raw = projectRecordedAdmissionFacts(await liveState());
    expect(raw.evidence).toHaveLength(1);
    expect(raw.waivers).toHaveLength(1);

    const resolved = resolveRecordedLedger(raw);
    expect(resolved.claimedRequirementIds.has(GATE_SCOPE.requirementId)).toBe(true);
    expect(resolved.activeEvidence.map((e) => e.evidenceId)).toEqual([
      'ev:gate:plan-artifact:ledger',
    ]);

    // A state with no event log at all yields the empty ledger — the fail-SAFE
    // direction for an affordance caller whose payload was stripped at a
    // serialization boundary.
    expect(projectRecordedAdmissionFacts({}).evidence).toEqual([]);
  });

  // ── Provenance is reported, not assumed ────────────────────────────────────
  it('Admission_EvidenceProvenance_DistinguishesRecordedFromDerived', async () => {
    const before = translateEdgeAdmission(GATE_EDGE, await liveState(), trusting());
    expect(before.evidenceProvenance).toBe('derived');

    await eventStore.append(
      featureId,
      {
        type: 'admission.evidence-recorded',
        timestamp: new Date().toISOString(),
        source: 'test-producer',
        data: gateEvidenceEvent({
          evidenceId: 'ev:gate:plan-artifact:claimed',
          verdict: 'pass',
        }),
      },
      { idempotencyKey: `${featureId}:claimed` },
    );

    const after = translateEdgeAdmission(GATE_EDGE, await liveState(), trusting());
    expect(after.evidenceProvenance).toBe('recorded');
    expect(after.evidence.map((e) => e.evidenceId)).toEqual([
      'ev:gate:plan-artifact:claimed',
    ]);
  });
});
