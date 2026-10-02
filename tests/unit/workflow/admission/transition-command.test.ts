// Exit-proof tests for the sole admission chokepoint.
//
// (a) The admission decision and the phase-transition lifecycle event commit together as one atomic unit.
//     A fault before the commit leaves neither event.
// (b) A retried transition returns the identical recorded decision.
// (c) A denied attempt records the attempt and the decision, and the phase does not change.
// (d) An indeterminate verdict fails closed and does not change the phase.
// (e) A stale expected version raises a typed `ConcurrencyError`.
// (f) Cleanup uses the same atomic primitive.
//
// Route legality comes before admission. An illegal edge never reaches admission and persists nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../../src/events/atomic-appender.js';
import type {
  DecideOnceContext,
  DecideOnceDecision,
} from '../../../../src/events/atomic-appender.js';
import { ConcurrencyError } from '../../../../src/events/concurrency-error.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

import {
  runTransitionCommand,
  runCleanupCommand,
  type AdmissionDecider,
  type TransitionCommandInput,
  type TransitionDecided,
} from '../../../../src/workflow/admission/transition-command.js';
import { resolveRequirements } from '../../../../src/workflow/admission/requirement-resolution.js';
import { freezeRequirements } from '../../../../src/workflow/admission/freeze-requirements.js';
import { buildRequirementContext } from '../../../../src/workflow/admission/requirement-context.js';
import {
  compileEdgeCondition,
  type EdgeConditionDeclaration,
} from '../../../../src/workflow/admission/edge-condition.js';
import type { EdgeConditionFacts } from '../../../../src/workflow/admission/edge-condition-evaluate.js';
import type { EdgeCandidate } from '../../../../src/workflow/admission/edge-condition-select.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import {
  createCapabilityAuthority,
  POLICY_CAPABILITY,
} from '../../../../src/workflow/admission/policy-authority.js';
import {
  AdmissionEvidenceV1Schema,
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  type AdmissionEvidenceV1,
  type ContentDigestV1,
} from '../../../../src/workflow/admission/types.js';
import type { ResolvedGate } from '../../../../src/workflow/phase-kind.js';

const AT = '2026-08-03T12:00:00.000Z';
const digestA: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };
const digestB: ContentDigestV1 = { algorithm: 'sha256', value: 'b'.repeat(64) };

const phaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-txn-001');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);

/** GATHER has no phase-kind gates, so the declared gate is the only obligation: one gate-evidence requirement. */
const declaredGate: ResolvedGate = { family: 'ladder', gate: 'check_static_analysis' };
const requirementContext = buildRequirementContext({
  phaseKind: 'GATHER',
  risk: 'low',
  boundary: false,
  reliability: 'reliable',
  declaredGates: [declaredGate],
  policy: { minimumApprovals: 0, waivable: true },
});

/** The deterministic requirement ID that the chokepoint mints. Matching evidence binds to it. */
const gateRequirementId = (() => {
  const resolved = resolveRequirements(requirementContext);
  const frozen = freezeRequirements({ resolved, phaseAttemptId, subject });
  const first = frozen.requirements[0];
  if (first === undefined) throw new Error('fixture: expected one frozen requirement');
  return first.requirementId;
})();

const PRODUCER_ID = 'producer.gate-runner';
const authority = createCapabilityAuthority([
  { principalId: PRODUCER_ID, capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
]);

const gateEvidence = (
  verdict: 'pass' | 'fail' | 'indeterminate',
): AdmissionEvidenceV1 =>
  AdmissionEvidenceV1Schema.parse({
    contractVersion: '1.0',
    evidenceId: `evidence.${verdict}`,
    requirementId: gateRequirementId,
    phaseAttemptId,
    subject,
    producer: {
      producerId: PRODUCER_ID,
      providerRef: 'provider.static-analysis',
      providerVersion: '1.0.0',
      invocationId: 'invocation-001',
    },
    policyId: 'policy-001',
    policyDigest: digestA,
    contentDigest: digestB,
    createdAt: AT,
    kind: 'gate',
    verdict,
  });

const caller = {
  principalKind: 'agent',
  principalId: 'principal.orchestrator',
  role: 'orchestrator',
} as const;
const authorization = {
  authorizationId: 'authorization-001',
  posture: 'task-isolated',
  capabilityIds: ['capability.transition'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;

const declaration = {
  fields: { ready: 'boolean' },
} as const satisfies EdgeConditionDeclaration;
const legalCondition = compileEdgeCondition(
  { kind: 'factEquals', field: 'ready', value: true },
  declaration,
);
const legalFacts: EdgeConditionFacts = { fields: { ready: true }, events: [] };
const illegalFacts: EdgeConditionFacts = { fields: { ready: false }, events: [] };
const legalEdge: EdgeCandidate = { edgeId: 'gather->plan', condition: legalCondition };

function makeInput(
  appender: AdmissionDecider,
  overrides: {
    operationId?: string;
    expectedVersion?: number;
    activeEvidence?: readonly AdmissionEvidenceV1[];
    facts?: EdgeConditionFacts;
    candidates?: readonly EdgeCandidate[];
    streamId?: string;
  } = {},
): TransitionCommandInput {
  return {
    appender,
    streamId: overrides.streamId ?? 'workflow.feature-alpha',
    operationId: OperationIdSchema.parse(overrides.operationId ?? 'operation-001'),
    expectedVersion: overrides.expectedVersion ?? 0,
    route: {
      candidates: overrides.candidates ?? [legalEdge],
      facts: overrides.facts ?? legalFacts,
    },
    lifecycle: {
      phaseAttemptId,
      subject,
      fromPhase: 'gather',
      toPhase: 'plan',
      trigger: 'execute-transition',
      featureId: 'feature-alpha',
    },
    admission: {
      requirementContext,
      activeEvidence: overrides.activeEvidence ?? [gateEvidence('pass')],
      authority,
      evaluatedAt: AT,
      freshnessHorizonMs: 3_600_000,
      policyId: PolicyIdSchema.parse('policy-001'),
      policyVersion: '1.0',
      policyDigest: digestA,
    },
    provenance: { caller, authorization },
  };
}

function assertDecided(result: {
  outcome: string;
}): asserts result is TransitionDecided {
  if (result.outcome === 'route-blocked' || result.outcome === 'no-route') {
    throw new Error(`expected an admission decision, got ${result.outcome}`);
  }
}

describe('runTransitionCommand — atomic admission over a real appender', () => {
  let stateDir: string;
  let appender: AtomicAppender;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'transition-command-'));
    appender = new AtomicAppender({ stateDir });
  });

  afterEach(async () => {
    appender.getSqliteBackend()?.close();
    await rmrfAsync(stateDir);
  });

  const eventsOf = (streamId: string): { type: string; sequence: number }[] =>
    (appender.getSqliteBackend()?.queryEvents(streamId) ?? []).map((event) => ({
      type: String((event as { type: unknown }).type),
      sequence: Number((event as { sequence: unknown }).sequence),
    }));

  /** (a) Both events are present with consecutive sequences, so they are one atomic unit. */
  it('Admit_AllowVerdict_AppendsDecisionAndLifecycleAsAtomicSiblings', async () => {
    const streamId = 'workflow.allow';
    const result = await runTransitionCommand(makeInput(appender, { streamId }));
    assertDecided(result);

    expect(result.outcome).toBe('admitted');
    expect(result.verdict).toBe('allow');
    expect(result.phaseChanged).toBe(true);
    expect(result.decision.outcome).toBe('allow');
    expect(result.appendedEventTypes).toEqual([
      'admission.transition-decided',
      'workflow.transition',
    ]);

    const events = eventsOf(streamId);
    expect(events.map((e) => e.type)).toEqual([
      'admission.transition-decided',
      'workflow.transition',
    ]);
    expect(events[1]!.sequence).toBe(events[0]!.sequence + 1);
  });

  /** (b) The retry returns the recorded decision and commits no new events. */
  it('Retry_SameOperationId_ReturnsIdenticalDecisionWithoutDuplicateEvents', async () => {
    const streamId = 'workflow.retry';
    const first = await runTransitionCommand(makeInput(appender, { streamId }));
    const second = await runTransitionCommand(makeInput(appender, { streamId }));
    assertDecided(first);
    assertDecided(second);

    expect(second.decision).toEqual(first.decision);
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(eventsOf(streamId).map((e) => e.type)).toEqual([
      'admission.transition-decided',
      'workflow.transition',
    ]);
  });

  /** (c) The attempt and the decision are recorded. The phase does not advance, and no lifecycle event exists. */
  it('Deny_MissingEvidence_RecordsAttemptButLeavesPhaseUnchanged', async () => {
    const streamId = 'workflow.deny';
    const result = await runTransitionCommand(
      makeInput(appender, { streamId, activeEvidence: [] }),
    );
    assertDecided(result);

    expect(result.outcome).toBe('denied');
    expect(result.verdict).toBe('deny');
    expect(result.phaseChanged).toBe(false);
    expect(result.decision.outcome).toBe('deny');
    if (result.decision.outcome === 'deny') {
      expect(result.decision.unsatisfiedRequirements[0]?.reason).toBe('missing');
      expect(result.decision.remediation.length).toBeGreaterThan(0);
    }
    const events = eventsOf(streamId);
    expect(events.map((e) => e.type)).toEqual(['admission.transition-decided']);
    expect(events.some((e) => e.type === 'workflow.transition')).toBe(false);
  });

  /** An authority that trusts no principal makes the passing gate evidence unauthorized. */
  it('Deny_UnauthorizedProducer_PersistsUnauthorizedReason', async () => {
    const streamId = 'workflow.unauthorized';
    const noTrustAppenderInput = makeInput(appender, {
      streamId,
      activeEvidence: [gateEvidence('pass')],
    });
    const result = await runTransitionCommand({
      ...noTrustAppenderInput,
      admission: {
        ...noTrustAppenderInput.admission,
        authority: createCapabilityAuthority([]),
      },
    });
    assertDecided(result);
    expect(result.verdict).toBe('deny');
    if (result.decision.outcome === 'deny') {
      expect(result.decision.unsatisfiedRequirements[0]?.reason).toBe('unauthorized');
    }
    expect(eventsOf(streamId).some((e) => e.type === 'workflow.transition')).toBe(false);
  });

  /** (d) An indeterminate verdict fails closed and never advances the phase. */
  it('Indeterminate_UndecidedGate_FailsClosedWithoutPhaseMutation', async () => {
    const streamId = 'workflow.indeterminate';
    const result = await runTransitionCommand(
      makeInput(appender, { streamId, activeEvidence: [gateEvidence('indeterminate')] }),
    );
    assertDecided(result);

    expect(result.outcome).toBe('indeterminate');
    expect(result.verdict).toBe('indeterminate');
    expect(result.phaseChanged).toBe(false);
    expect(result.decision.outcome).toBe('indeterminate');
    const events = eventsOf(streamId);
    expect(events.map((e) => e.type)).toEqual(['admission.transition-decided']);
  });

  /**
   * (e) A concurrent writer advances the stream, but the caller expects version 0.
   * The command raises a typed conflict and persists no admission event.
   */
  it('OCC_StaleExpectedVersion_RaisesTypedConcurrencyError', async () => {
    const streamId = 'workflow.stale';
    await appender.appendUnkeyed(streamId, [{ type: 'noise.event', data: {} }]);

    await expect(
      runTransitionCommand(makeInput(appender, { streamId, expectedVersion: 0 })),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    expect(eventsOf(streamId).some((e) => e.type.startsWith('admission.'))).toBe(false);
  });

  it('Route_NoMatch_ShortCircuitsBeforeAdmissionWithNoPersistence', async () => {
    const streamId = 'workflow.no-route';
    const result = await runTransitionCommand(
      makeInput(appender, { streamId, facts: illegalFacts }),
    );
    expect(result.outcome).toBe('no-route');
    expect(eventsOf(streamId)).toEqual([]);
  });

  /**
   * (f) The cleanup phase change is one atomic `decideOnce` append.
   * A stale version is a typed conflict, as on the transition path. A retry with the same operation ID adds no cleanup event.
   */
  it('Cleanup_RoutesThroughSameAtomicPrimitive', async () => {
    const streamId = 'workflow.cleanup';
    const result = await runCleanupCommand({
      appender,
      streamId,
      operationId: OperationIdSchema.parse('operation-cleanup-1'),
      expectedVersion: 0,
      fromPhase: 'implement',
      toPhase: 'cleanup',
      trigger: 'cleanup',
      featureId: 'feature-alpha',
      phaseAttemptId,
    });
    expect(result.outcome).toBe('cleaned-up');
    expect(eventsOf(streamId).map((e) => e.type)).toEqual(['workflow.cleanup']);

    await expect(
      runCleanupCommand({
        appender,
        streamId,
        operationId: OperationIdSchema.parse('operation-cleanup-2'),
        expectedVersion: 0,
        fromPhase: 'implement',
        toPhase: 'cleanup',
        trigger: 'cleanup',
        featureId: 'feature-alpha',
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    await runCleanupCommand({
      appender,
      streamId,
      operationId: OperationIdSchema.parse('operation-cleanup-1'),
      expectedVersion: 0,
      fromPhase: 'implement',
      toPhase: 'cleanup',
      trigger: 'cleanup',
      featureId: 'feature-alpha',
      phaseAttemptId,
    });
    expect(eventsOf(streamId).map((e) => e.type)).toEqual(['workflow.cleanup']);
  });
});

/**
 * A recording {@link AdmissionDecider}. It runs the closure, so the chokepoint events are observable.
 * Then it returns the result, or throws a simulated I/O fault before the commit. It persists nothing.
 */
class RecordingDecider implements AdmissionDecider {
  readonly calls: {
    operationId: string;
    requestDigest: string;
    decision: DecideOnceDecision<unknown>;
  }[] = [];

  constructor(private readonly mode: 'commit' | 'fault-before-commit') {}

  async decideOnce<TResult>(
    operationId: string,
    requestDigest: string,
    closure: (ctx: DecideOnceContext) => DecideOnceDecision<TResult>,
  ): Promise<TResult> {
    const ctx: DecideOnceContext = {
      readStream: () => ({ events: [], version: 0 }),
    };
    const decision = closure(ctx);
    this.calls.push({ operationId, requestDigest, decision });
    if (this.mode === 'fault-before-commit') {
      throw new Error('injected I/O fault after decision, before durable commit');
    }
    return decision.result;
  }
}

describe('runTransitionCommand — single atomic unit (no partial siblings)', () => {
  /** The chokepoint makes one `decideOnce` call that carries both events in order. It never appends the decision alone. */
  it('Atomic_AllowVerdict_IssuesOneDecideOnceCarryingBothSiblings', async () => {
    const decider = new RecordingDecider('commit');
    const result = await runTransitionCommand(makeInput(decider));
    assertDecided(result);

    expect(decider.calls).toHaveLength(1);
    const only = decider.calls[0]!;
    expect(only.decision.events.map((e) => e.type)).toEqual([
      'admission.transition-decided',
      'workflow.transition',
    ]);
    expect(only.decision.expectedSequence).toBe(0);
  });

  /**
   * (a) A fault between the decision and the commit surfaces.
   * Both events live in the single `decideOnce` unit, so nothing commits. Two separate appends leave the decision behind.
   */
  it('Atomic_FaultBeforeCommit_LeavesNeitherSibling', async () => {
    const decider = new RecordingDecider('fault-before-commit');

    await expect(runTransitionCommand(makeInput(decider))).rejects.toThrow(
      /injected I\/O fault/,
    );
    expect(decider.calls).toHaveLength(1);
    expect(decider.calls[0]!.decision.events.map((e) => e.type)).toEqual([
      'admission.transition-decided',
      'workflow.transition',
    ]);
  });
});
