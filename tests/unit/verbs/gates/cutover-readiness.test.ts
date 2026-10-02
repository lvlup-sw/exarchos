// ─── #1739 — cutover promotion verb tests ────────────────────────────────────
//
// The load-bearing claims:
//   * `cutover_readiness` names EVERY unmet condition individually, and
//     reports ready only when all six hold — with no side effects;
//   * `cutover_decide` is operator-gated (T-03: ambient dispatch authorization
//     only — a delegated agent or contextless caller is denied before any
//     append);
//   * an unsatisfied gate records the `continue-shadow` rollout decision but
//     REFUSES the enablement fact with a typed error naming the unmet
//     conditions;
//   * a satisfied gate appends `admission.rollout-decision`
//     (approve-enforcement) and THEN `admission.enforcement-enabled`, linked
//     by `rolloutDecisionId`.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADMISSION_STREAM_ID } from '../../../../src/dispatch/core/infra-streams.js';
import {
  deriveLocalOperatorIdentity,
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  type GateConditionId,
  type LiveShadowAttempt,
} from '../../../../src/workflow/admission/cutover-gate.js';
import type { LiveShadowHealth } from '../../../../src/workflow/admission/live-shadow-observer.js';
import {
  handleCutoverDecide,
  handleCutoverReadiness,
  type CutoverVerbDeps,
} from '../../../../src/verbs/gates/cutover-readiness.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────


/**
 * Tests for the cutover verbs.
 *
 * `cutover_readiness` names each unmet condition and reports ready only when all six hold. It appends nothing.
 *
 * `cutover_decide` requires the operator role. It denies a delegated agent or a contextless caller before any append.
 * An unsatisfied gate records a `continue-shadow` rollout decision and refuses the enablement fact with a typed error.
 * A satisfied gate appends `admission.rollout-decision` and then `admission.enforcement-enabled`, linked by `rolloutDecisionId`.
 */

const AT = '2026-07-21T20:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const digest = () => ({ algorithm: 'sha256' as const, value: SHA_A });

const observerCaller = {
  principalKind: 'service' as const,
  principalId: 'exarchos.live-shadow-observer',
  role: 'shadow-observer',
};
const observerAuthorization = {
  authorizationId: 'live-shadow-observer:process',
  posture: 'read-only' as const,
  capabilityIds: ['admission:shadow-observe'],
  resolverVersion: '1.0',
  resolvedAt: AT,
};

function shadowAttemptData(shadowAttemptId: string): Record<string, unknown> {
  return {
    eventVersion: '1.0',
    shadowAttemptId,
    operationId: 'op-1',
    phaseAttemptId: 'pa-1',
    legacyOutcome: 'allow',
    subject: { kind: 'phase-attempt', phaseAttemptId: 'pa-1', digest: digest() },
    evidenceSetDigest: digest(),
    decision: {
      contractVersion: '1.0',
      decisionId: `shadow-decision:${shadowAttemptId}`,
      operationId: 'op-1',
      phaseAttemptId: 'pa-1',
      policyId: 'policy.legacy-state-translation',
      policyVersion: '1.0',
      policyDigest: digest(),
      requirementSetDigest: digest(),
      inputDigest: digest(),
      evidenceIds: [],
      waiverIds: [],
      decidedAt: AT,
      outcome: 'allow',
      satisfiedRequirementIds: [],
      waivedRequirementIds: [],
    },
    attemptedAt: AT,
    caller: observerCaller,
    authorization: observerAuthorization,
  };
}

function satisfiableLiveAttempts(): readonly LiveShadowAttempt[] {
  const attempts: LiveShadowAttempt[] = [];
  for (const phaseKind of ALL_PHASE_KINDS) {
    attempts.push(
      { phaseKind, outcome: 'allow', disagreementClass: 'agree' },
      { phaseKind, outcome: 'deny', disagreementClass: 'agree' },
    );
  }
  while (attempts.length < MINIMUM_LIVE_ATTEMPTS) {
    attempts.push({
      phaseKind: 'IMPLEMENT',
      outcome: 'allow',
      disagreementClass: 'agree',
    });
  }
  return attempts;
}

function healthyObserver(): LiveShadowHealth {
  const observed = satisfiableLiveAttempts().length;
  return {
    attemptsObserved: observed,
    appendsScheduled: observed,
    appendsSucceeded: observed,
    appendsFailed: 0,
    streamUnresolved: 0,
    observationsThrew: 0,
  };
}

const EMPTY_DEPS: CutoverVerbDeps = {
  liveAttempts: () => [],
  observerHealth: () => ({
    attemptsObserved: 0,
    appendsScheduled: 0,
    appendsSucceeded: 0,
    appendsFailed: 0,
    streamUnresolved: 0,
    observationsThrew: 0,
  }),
};

const SATISFIED_DEPS: CutoverVerbDeps = {
  liveAttempts: () => satisfiableLiveAttempts(),
  observerHealth: () => healthyObserver(),
};

const ALL_CONDITIONS: readonly GateConditionId[] = [
  'deterministic-corpus-clean',
  'live-attempt-threshold',
  'phase-kind-coverage',
  'outcome-coverage',
  'live-disagreement-class',
  'live-observer-health',
];

describe('CutoverReadiness / CutoverDecide (#1739)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'exarchos-cutover-verbs-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  async function seedSatisfiableDurableEvidence(): Promise<void> {
    await eventStore.append('feat-a/admission-shadow', {
      type: 'admission.shadow-attempt',
      timestamp: AT,
      source: 'live-shadow-observer',
      data: shadowAttemptData('shadow-attempt:seed-1'),
    });
  }

  function operatorContext() {
    return mintDispatchContext(
      undefined,
      snapshotCallerAuthorization(
        deriveLocalOperatorIdentity(stateDir),
        undefined,
        () => AT,
      ),
    );
  }

  function agentContext() {
    return mintDispatchContext(
      undefined,
      snapshotCallerAuthorization(
        deriveMcpCallerIdentity({ sessionId: 'cutover-test-session' }),
        createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec']),
        () => AT,
      ),
    );
  }

  /**
   * On a cold store, the corpus condition holds vacuously, because an empty disposition fold has no unexplained disagreements.
   * `live-disagreement-class` needs durable evidence, so it refuses the empty store. The report appends nothing.
   */
  it('CutoverReadiness_UnmetConditions_NamedIndividually', async () => {
    const result = await handleCutoverReadiness({}, stateDir, eventStore, EMPTY_DEPS);
    expect(result.success).toBe(true);
    const report = (result.data as {
      report: {
        satisfied: boolean;
        unmet: readonly string[];
        conditions: readonly { id: string; met: boolean; detail: string }[];
      };
    }).report;

    expect(report.satisfied).toBe(false);
    expect(report.conditions.map((c) => c.id)).toEqual(ALL_CONDITIONS);
    for (const condition of report.conditions) {
      expect(condition.detail.length).toBeGreaterThan(0);
    }
    expect(report.unmet).toEqual([
      'live-attempt-threshold',
      'phase-kind-coverage',
      'outcome-coverage',
      'live-disagreement-class',
      'live-observer-health',
    ]);

    expect(await eventStore.query(ADMISSION_STREAM_ID)).toEqual([]);
  });

  it('CutoverReadiness_AllSixSatisfied_ReportsReady', async () => {
    await seedSatisfiableDurableEvidence();
    const result = await handleCutoverReadiness(
      {},
      stateDir,
      eventStore,
      SATISFIED_DEPS,
    );
    expect(result.success).toBe(true);
    const data = result.data as {
      report: { satisfied: boolean; unmet: readonly string[] };
      durableEvidence: { featureIds: readonly string[]; attemptCount: number };
    };
    expect(data.report.satisfied).toBe(true);
    expect(data.report.unmet).toEqual([]);
    expect(data.durableEvidence.featureIds).toEqual(['feat-a']);
    expect(data.durableEvidence.attemptCount).toBe(1);
  });

  /**
   * A caller with no dispatch context fails closed. A delegated agent with a mutating posture is also denied, because the check is the operator role.
   * Neither denial appends an event.
   */
  it('CutoverDecide_NonOperatorCaller_Denied', async () => {
    const contextless = await handleCutoverDecide(
      {},
      stateDir,
      eventStore,
      SATISFIED_DEPS,
    );
    expect(contextless).toMatchObject({
      success: false,
      error: { code: 'CAPABILITY_DENIED', action: 'cutover_decide' },
    });

    const asAgent = await runWithDispatchContext(agentContext(), () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );
    expect(asAgent).toMatchObject({
      success: false,
      error: { code: 'CAPABILITY_DENIED' },
    });

    expect(await eventStore.query(ADMISSION_STREAM_ID)).toEqual([]);
  });

  /** The refusal names the unmet conditions. The handler records the `continue-shadow` rollout decision, but not the enablement fact. */
  it('CutoverDecide_GateUnsatisfied_RefusesEnablementFact', async () => {
    const result = await runWithDispatchContext(operatorContext(), () =>
      handleCutoverDecide({}, stateDir, eventStore, EMPTY_DEPS),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'CUTOVER_GATE_NOT_SATISFIED' });
    expect(result.error?.unmetGates).toEqual([
      'live-attempt-threshold',
      'phase-kind-coverage',
      'outcome-coverage',
      'live-disagreement-class',
      'live-observer-health',
    ]);

    const rollouts = await eventStore.query(ADMISSION_STREAM_ID, {
      type: 'admission.rollout-decision',
    });
    expect(rollouts).toHaveLength(1);
    expect(rollouts[0]?.data).toMatchObject({ outcome: 'continue-shadow' });
    expect(
      await eventStore.query(ADMISSION_STREAM_ID, {
        type: 'admission.enforcement-enabled',
      }),
    ).toEqual([]);
  });

  /** The enablement fact links through `rolloutDecisionId` to the rollout decision that approved it. */
  it('CutoverDecide_GateSatisfied_AppendsRolloutDecisionThenEnablement', async () => {
    await seedSatisfiableDurableEvidence();
    const result = await runWithDispatchContext(operatorContext(), () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      outcome: string;
      rolloutDecisionId: string;
      enablementId: string;
    };
    expect(data.outcome).toBe('approve-enforcement');

    const events = await eventStore.query(ADMISSION_STREAM_ID);
    expect(events.map((e) => e.type)).toEqual([
      'admission.rollout-decision',
      'admission.enforcement-enabled',
    ]);
    expect(events[0]?.data).toMatchObject({
      outcome: 'approve-enforcement',
      rolloutDecisionId: data.rolloutDecisionId,
      caller: { principalKind: 'operator' },
    });
    expect(events[1]?.data).toMatchObject({
      enablementId: data.enablementId,
      rolloutDecisionId: data.rolloutDecisionId,
    });
  });

  /** A retry in the same dispatch has the same operationId and evidence. It derives the same natural-identity keys, so it collapses onto the stored rows. */
  it('CutoverDecide_SameOperationRetry_DoesNotDuplicateFacts', async () => {
    await seedSatisfiableDurableEvidence();
    const context = operatorContext();
    await runWithDispatchContext(context, () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );
    await runWithDispatchContext(context, () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );

    const events = await eventStore.query(ADMISSION_STREAM_ID);
    expect(events.map((e) => e.type)).toEqual([
      'admission.rollout-decision',
      'admission.enforcement-enabled',
    ]);
  });
});
