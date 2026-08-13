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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADMISSION_STREAM_ID } from '../../dispatch/core/infra-streams.js';
import {
  deriveLocalOperatorIdentity,
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../dispatch/dispatch-context.js';
import { createInMemoryResolver } from '../../workflow/capabilities/resolver.js';
import { EventStore } from '../../events/store.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  type GateConditionId,
  type LiveShadowAttempt,
} from '../../workflow/admission/cutover-gate.js';
import type { LiveShadowHealth } from '../../workflow/admission/live-shadow-observer.js';
import {
  handleCutoverDecide,
  handleCutoverReadiness,
  type CutoverVerbDeps,
} from './cutover-readiness.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

// ─── Suite ────────────────────────────────────────────────────────────────────

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
    await rm(stateDir, { recursive: true, force: true });
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

  // ── cutover_readiness ──────────────────────────────────────────────────────

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
    // Every condition is present in the report, individually named and
    // carrying a non-empty diagnostic detail.
    expect(report.conditions.map((c) => c.id)).toEqual(ALL_CONDITIONS);
    for (const condition of report.conditions) {
      expect(condition.detail.length).toBeGreaterThan(0);
    }
    // On a cold store with no live activity, exactly these five are unmet
    // (an EMPTY disposition fold has zero unexplained disagreements, so the
    // corpus condition is met vacuously — the durable-evidence condition is
    // what refuses the empty store).
    expect(report.unmet).toEqual([
      'live-attempt-threshold',
      'phase-kind-coverage',
      'outcome-coverage',
      'live-disagreement-class',
      'live-observer-health',
    ]);

    // Read-only: assembling the report appended nothing.
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

  // ── cutover_decide ─────────────────────────────────────────────────────────

  it('CutoverDecide_NonOperatorCaller_Denied', async () => {
    // No dispatch context at all: fails closed.
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

    // A delegated agent (role 'agent') with a MUTATING posture is still
    // denied: the bar is the operator ROLE, not the posture alone.
    const asAgent = await runWithDispatchContext(agentContext(), () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );
    expect(asAgent).toMatchObject({
      success: false,
      error: { code: 'CAPABILITY_DENIED' },
    });

    // Neither denial appended anything.
    expect(await eventStore.query(ADMISSION_STREAM_ID)).toEqual([]);
  });

  it('CutoverDecide_GateUnsatisfied_RefusesEnablementFact', async () => {
    const result = await runWithDispatchContext(operatorContext(), () =>
      handleCutoverDecide({}, stateDir, eventStore, EMPTY_DEPS),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'CUTOVER_GATE_NOT_SATISFIED' });
    // The refusal NAMES the unmet conditions.
    expect(result.error?.unmetGates).toEqual([
      'live-attempt-threshold',
      'phase-kind-coverage',
      'outcome-coverage',
      'live-disagreement-class',
      'live-observer-health',
    ]);

    // The rollout decision (continue-shadow) IS recorded; the enablement
    // fact is NOT.
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
    // The enablement fact is LINKED to the rollout decision that approved it.
    expect(events[1]?.data).toMatchObject({
      enablementId: data.enablementId,
      rolloutDecisionId: data.rolloutDecisionId,
    });
  });

  it('CutoverDecide_SameOperationRetry_DoesNotDuplicateFacts', async () => {
    await seedSatisfiableDurableEvidence();
    const context = operatorContext();
    await runWithDispatchContext(context, () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );
    // A retry within the SAME dispatch (same operationId, same evidence)
    // derives the same natural-identity keys and collapses onto the stored
    // rows (INV-8 / T-49).
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
