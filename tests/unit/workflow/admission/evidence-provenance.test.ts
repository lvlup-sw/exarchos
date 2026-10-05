/**
 * For a requirement that a recorded fact claims, the legacy-state translation
 * evaluates the recorded evidence. It derives an attestation only for an
 * unclaimed requirement. So admission can deny for `stale`, `unauthorized`,
 * `malformed`, `contradictory`, and `failed` evidence, and a scoped waiver can
 * rescue a gate.
 *
 * The tests start at the public root, because a test that calls `adjudicateEdge`
 * or `evaluatePolicy` directly can pass while the live path is wrong. The deny
 * tests run `handleWorkflow` transitions on a real `EventStore` and read the
 * durable `admission.shadow-attempt` record. The waiver tests call
 * `adjudicateOutboundEdges` over state that `hydrateEventsFromStore` builds.
 * The tests append the proof facts to the feature stream, as the gate runner
 * does in production.
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
} from '../../../../src/workflow/admission/legacy-state-translation.js';
import { getEdgeIR, type WorkflowEdgeIR } from '../../../../src/workflow/admission/built-in-workflow-ir.js';
import {
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  liveShadowSink,
} from '../../../../src/workflow/admission/live-shadow-observer.js';
import { EventStore } from '../../../../src/events/store.js';
import { AdmissionShadowAttemptData } from '../../../../src/events/schemas.js';
import { handleWorkflow } from '../../../../src/workflow/composite.js';
import { handleGet, handleSet } from '../../../../src/workflow/tools.js';
import { hydrateEventsFromStore } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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
 * One `admission.evidence-recorded` payload. Each field that a producer
 * controls is a parameter, so a test can vary each one.
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

/**
 * Each test starts a feature workflow at `plan` with the plan artifact, so the
 * legacy guard admits the transition. A deny that follows comes from the
 * recorded evidence, not from an unready workflow.
 */
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

  /**
   * Control: the same transition with nothing recorded. The derived attestation
   * governs an unclaimed requirement, so admission allows. Without this control,
   * each deny below can come from the harness.
   */
  it('Admission_NoRecordedEvidence_FallsBackToDerivedAttestationAndAllows', async () => {
    const featureId = 'provenance-control';
    await seedFeatureAtPlan(featureId);

    const { transition, durable } = await transitionAndReadShadow(featureId);

    expect(transition.success).toBe(true);
    expect(durable.decision.outcome).toBe('allow');
  });

  /** The evidence is well formed and authorized, so its age is the only fault. */
  it('Admission_StaleEvidence_Denies', async () => {
    const featureId = 'provenance-stale';
    await seedFeatureAtPlan(featureId);

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

  /** The evidence is fresh, well formed, and says `pass`, but the authority does not trust its producer. */
  it('Admission_UnauthorizedProducerEvidence_Denies', async () => {
    const featureId = 'provenance-unauthorized';
    await seedFeatureAtPlan(featureId);

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

  /** The evidence names the right requirement but carries the subject and phase attempt of another edge. */
  it('Admission_MalformedEvidence_Denies', async () => {
    const featureId = 'provenance-malformed';
    await seedFeatureAtPlan(featureId);

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

  /**
   * No `admission.contradiction-recorded` fact exists. The contradiction exists
   * only because `selectEvidence` finds two active records with opposite
   * statements in one scope. Without the selector, `evaluateGate` finds the
   * passing record and allows.
   */
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

  /**
   * The two records have opposite verdicts, as in the contradiction case, but
   * the `pass` record supersedes the `fail` record. The recorded ledger honors
   * the link, so one active record remains and admission allows.
   */
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

  /**
   * The legacy state has the plan artifact, so the derived attestation says
   * `pass`. A trusted, fresh producer says `fail`. Recorded facts govern the
   * requirement they claim, so admission denies with `failed`.
   */
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

/**
 * Waiver-grant trust is out of band, like evidence-issuance trust. The default
 * translation context declares no grantors, so waivers fail closed until a
 * deployment declares one. `trusting()` declares `WAIVER_ACTOR_ID`. The workflow
 * has no plan artifact, so the gate is unsatisfied with `missing` and a waiver
 * has something to rescue.
 */
describe('DR-35 — the waiver branch is reachable and strictly scoped', () => {
  let stateDir: string;
  let eventStore: EventStore;
  const featureId = 'waiver-scope';

  const ctx = () => ({ stateDir, eventStore, enableTelemetry: false });

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

  /**
   * The unsatisfied gate denies first, so a later allow means something. A
   * waiver does not apply when it names another subject or requirement, is
   * expired, or comes from an untrusted grantor. The other-subject waiver names
   * this requirement, so only the subject check rejects it. The exact waiver
   * applies, keeps the recorded failure, and does not rescue the approval edge.
   */
  it('Admission_ScopedWaiver_AppliesOnlyToDeclaredSubject', async () => {
    expect(await gateVerdict()).toBe('deny');

    expect(APPROVAL_SCOPE.subject).not.toEqual(GATE_SCOPE.subject);
    await recordWaiver({
      key: 'other-subject',
      waiverId: 'waiver:other-subject',
      scope: APPROVAL_SCOPE,
      waivedRequirementIds: [GATE_SCOPE.requirementId],
    });
    expect(await gateVerdict()).toBe('deny');

    await recordWaiver({
      key: 'other-requirement',
      waiverId: 'waiver:other-requirement',
      waivedRequirementIds: ['req:gate:some-other-gate:feature:plan:plan-review'],
    });
    expect(await gateVerdict()).toBe('deny');

    await recordWaiver({
      key: 'expired',
      waiverId: 'waiver:expired',
      expiresAt: iso(now() - HOUR_MS),
    });
    expect(await gateVerdict()).toBe('deny');

    await recordWaiver({
      key: 'untrusted',
      waiverId: 'waiver:untrusted',
      actorId: 'agent.self-appointed',
    });
    expect(await gateVerdict()).toBe('deny');

    await recordWaiver({ key: 'exact', waiverId: 'waiver:plan-artifact' });
    expect(await gateVerdict()).toBe('allow');

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

    const elsewhere = adjudicateOutboundEdges(
      'feature',
      'plan-review',
      await liveState(),
      trusting(),
      { eventLogAvailable: true },
    );
    expect(elsewhere.get('delegate')?.verdict).toBe('deny');
  });

  /** The default live context declares no waiver grantors, so the waiver that applies under `trusting()` grants nothing. */
  it('Admission_WaiverWithoutADeclaredGrantor_IsFailClosed', async () => {
    await recordWaiver({ key: 'exact', waiverId: 'waiver:plan-artifact' });

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

  /**
   * A waiver must not stand in for a required human approval. So the gate
   * obligation is waivable and the approval obligation is not.
   */
  it('Admission_GateObligationIsWaivable_ApprovalObligationIsNot', async () => {
    const state = await liveState();

    const gate = translateEdgeAdmission(GATE_EDGE, state, trusting());
    expect(gate.obligations.waivable).toBe(true);

    const approval = translateEdgeAdmission(APPROVAL_EDGE, state, trusting());
    expect(approval.obligations.waivable).toBe(false);
    expect(APPROVAL_SCOPE.requirementId).not.toBe(GATE_SCOPE.requirementId);
  });

  /**
   * A state with no event log gives an empty ledger. This is the fail-safe
   * direction for a caller whose payload lost its events at a serialization
   * boundary.
   */
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

    expect(projectRecordedAdmissionFacts({}).evidence).toEqual([]);
  });

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
