// The cutover verbs declare real output schemas. This file checks four claims.
//
// 1. `cutover_readiness` and `cutover_decide` declare a substantive `outputSchema`.
//    The live census walks the Zod objects of the registry to measure this.
// 2. Both ids moved from `VACUITY_ALLOWLIST` to `VACUITY_RETIRED`.
//    Thus the seed key set, which the pin freezes, does not change.
// 3. The ratchet accepts a further move. It rejects an addition, a deletion,
//    and a waiver that stays after the schema is fixed.
// 4. The registry declarations accept what the handlers emit,
//    and reject what a vacuous schema accepts.
//
// @oracle-sources: ../../../src/registry.ts, ../../../tools/conformance/src/output-schema-seed-pin.ts

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  deriveLocalOperatorIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../src/events/store.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import {
  auditVacuityAllowlist,
  classifyOutputSchema,
} from '../../../tools/conformance/src/output-schema-census.js';
import {
  auditLiveVacuityRatchet,
  auditLiveVacuitySeedIntegrity,
  censusLiveOutputSchemas,
  liveVacuitySeedDigest,
  OUTPUT_SCHEMA_PORTS,
} from '../../../tools/conformance/src/bindings/output-schema.js';
import {
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED_IDS,
} from '../../../src/output-schema-vacuity-allowlist.js';
import { VACUITY_SEED_KEY_SET_DIGEST } from '../../../tools/conformance/src/output-schema-seed-pin.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  type LiveShadowAttempt,
} from '../../../src/workflow/admission/cutover-gate.js';
import type { LiveShadowHealth } from '../../../src/workflow/admission/live-shadow-observer.js';
import { DISAGREEMENT_CLASSES } from '../../../src/workflow/admission/shadow-decision.js';
import { extractEnvelopeDataSchema } from '../../../src/verbs/worktree/schemas.js';
import {
  CutoverDecideData,
  CutoverGateReportSchema,
  CutoverReadinessData,
  type DurableEvidenceSummary,
} from '../../../src/verbs/gates/cutover-readiness-schema.js';
import {
  handleCutoverDecide,
  handleCutoverReadiness,
  type CutoverVerbDeps,
} from '../../../src/verbs/gates/cutover-readiness.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const READINESS_ID = 'exarchos_orchestrate.cutover_readiness';
const DECIDE_ID = 'exarchos_orchestrate.cutover_decide';

/** The `outputSchema` the LIVE registry carries for `${tool}.${action}`. */
function declaredOutputSchema(id: string): z.ZodType {
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      if (`${tool.name}.${action.name}` === id) return action.outputSchema;
    }
  }
  throw new Error(`no registry declaration for '${id}'`);
}

/** The success-branch `data` sub-schema of that declaration. */
function declaredDataSchema(id: string): z.ZodType {
  const data = extractEnvelopeDataSchema(declaredOutputSchema(id));
  if (data === undefined) throw new Error(`no envelope 'data' branch on '${id}'`);
  return data;
}

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

/** All five disagreement classes seeded, as `emptyTally()` produces them. */
const FULL_TALLY: Record<string, number> = Object.fromEntries(
  DISAGREEMENT_CLASSES.map((c) => [c, 0]),
);

describe('Task 083 — the cutover verbs declare substantive outputSchemas', () => {
  /** The census walks the constructed Zod object. A text search for `vacuityWaiver` does not see a waiver under another name. */
  it('CutoverVerbs_LiveCensus_ClassifiesBothSubstantive', () => {
    for (const id of [READINESS_ID, DECIDE_ID]) {
      const verdict = classifyOutputSchema(declaredOutputSchema(id), OUTPUT_SCHEMA_PORTS);
      expect(verdict.classification).toBe('substantive');
      expect(verdict.reason).toBe('typed-data');
    }
  });

  /** The test asserts a non-empty census first. An empty census makes each exclusion pass for no reason. */
  it('CutoverVerbs_CensusVacuousPopulation_ExcludesBoth', () => {
    const census = censusLiveOutputSchemas();
    expect(census.total).toBeGreaterThan(0);
    expect(census.ok).toBe(true);
    expect(census.vacuous).not.toContain(READINESS_ID);
    expect(census.vacuous).not.toContain(DECIDE_ID);
    expect(census.substantive).toContain(READINESS_ID);
    expect(census.substantive).toContain(DECIDE_ID);
  });
});

describe('Task 083 — the waiver rows left the allowlist', () => {
  /**
   * The counts make a silent re-add visible. The seed holds 112 ids, and four are retired.
   * The fourth is `exarchos_view.stack_place`, which moved to `exarchos_orchestrate`.
   * A waiver under the new key is a key swap, which the seed digest rejects.
   */
  it('CutoverVerbs_WaiverSeed_MovedFromAllowlistToRetired', () => {
    expect(VACUITY_ALLOWLIST_IDS).not.toContain(READINESS_ID);
    expect(VACUITY_ALLOWLIST_IDS).not.toContain(DECIDE_ID);
    expect(VACUITY_RETIRED_IDS).toContain(READINESS_ID);
    expect(VACUITY_RETIRED_IDS).toContain(DECIDE_ID);
    expect(VACUITY_ALLOWLIST_IDS.length).toBe(108);
    expect(VACUITY_RETIRED_IDS.length).toBe(4);
  });

  /**
   * The pin is a second authority. `output-schema-seed-pin.ts` imports nothing, so it cannot observe the seed.
   * A deletion changes the digest. A move does not.
   */
  it('CutoverVerbs_SeedKeySet_UnchangedBecausePaydownIsAMove', () => {
    const live = liveVacuitySeedDigest([...VACUITY_ALLOWLIST_IDS, ...VACUITY_RETIRED_IDS]);
    expect(live).toBe(VACUITY_SEED_KEY_SET_DIGEST);
    expect(auditLiveVacuitySeedIntegrity().ok).toBe(true);
  });

  it('CutoverVerbs_LiveRatchet_IsGreen', () => {
    const verdict = auditLiveVacuityRatchet();
    expect(verdict.findings.map((f) => f.code)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

/** The first live waiver is the subject of a hypothetical next paydown. */
describe('Task 083 — the shrink-only ratchet, exercised in both directions', () => {
  const someLiveWaiver = VACUITY_ALLOWLIST_IDS[0] ?? '';

  /** A move does not change the seed size. This makes the pin usable. */
  it('VacuityRatchet_FurtherPaydownAsAMove_Accepted', () => {
    expect(someLiveWaiver.length).toBeGreaterThan(0);
    const verdict = auditLiveVacuitySeedIntegrity(
      VACUITY_ALLOWLIST_IDS.filter((id) => id !== someLiveWaiver),
      [...VACUITY_RETIRED_IDS, someLiveWaiver],
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.keySetSize).toBe(112);
  });

  it('VacuityRatchet_NewWaiverAdded_RejectedAsSeedDrift', () => {
    const verdict = auditLiveVacuitySeedIntegrity(
      [...VACUITY_ALLOWLIST_IDS, 'exarchos_orchestrate.a_brand_new_action'],
      [...VACUITY_RETIRED_IDS],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toContain('SEED_KEY_SET_DRIFT');
    expect(verdict.keySetSize).toBe(113);
  });

  it('VacuityRatchet_WaiverDeletedInsteadOfRetired_RejectedAsSeedDrift', () => {
    const verdict = auditLiveVacuitySeedIntegrity(
      VACUITY_ALLOWLIST_IDS.filter((id) => id !== someLiveWaiver),
      [...VACUITY_RETIRED_IDS],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toContain('SEED_KEY_SET_DRIFT');
  });

  /** The schema is fixed but the waiver stays. The declaration is not vacuous, so the audit reports the waiver as stale. */
  it('VacuityRatchet_WaiverKeptSideways_RejectedAsStale', () => {
    const verdict = auditVacuityAllowlist(censusLiveOutputSchemas(), [
      ...VACUITY_ALLOWLIST_IDS,
      READINESS_ID,
      DECIDE_ID,
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.stale).toContain(READINESS_ID);
    expect(verdict.stale).toContain(DECIDE_ID);
  });
});

describe('Task 083 — the declared contracts match the real emissions', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'exarchos-cutover-contract-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
  });

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

  /**
   * The emission must parse against the module contract and against the registry schema.
   * The registry schema is that contract after `withCappedShape` adds the capped fallback.
   * Otherwise the MCP validator turns a correct response into an `INTERNAL_ERROR`.
   */
  it('CutoverReadiness_ColdStoreEmission_ParsesAgainstTheRegistryDeclaration', async () => {
    const result = await handleCutoverReadiness({}, stateDir, eventStore, EMPTY_DEPS);
    expect(result.success).toBe(true);

    const direct = CutoverReadinessData.safeParse(result.data);
    expect(direct.error?.message).toBeUndefined();
    expect(direct.success).toBe(true);

    const declared = declaredDataSchema(READINESS_ID).safeParse(result.data);
    expect(declared.error?.message).toBeUndefined();
    expect(declared.success).toBe(true);
  });

  it('CutoverDecide_SatisfiedGateEmission_ParsesAgainstTheRegistryDeclaration', async () => {
    await eventStore.append('feat-a/admission-shadow', {
      type: 'admission.shadow-attempt',
      timestamp: AT,
      source: 'live-shadow-observer',
      data: shadowAttemptData('shadow-attempt:seed-1'),
    });

    const result = await runWithDispatchContext(operatorContext(), () =>
      handleCutoverDecide({}, stateDir, eventStore, SATISFIED_DEPS),
    );
    expect(result.success).toBe(true);

    const direct = CutoverDecideData.safeParse(result.data);
    expect(direct.error?.message).toBeUndefined();
    expect(direct.success).toBe(true);

    const declared = declaredDataSchema(DECIDE_ID).safeParse(result.data);
    expect(declared.error?.message).toBeUndefined();
    expect(declared.success).toBe(true);
  });

  /**
   * A vacuous `data` schema (`z.unknown()`) accepts each of these values.
   * The real schemas reject them, also a report without the field that the caller branches on.
   */
  it('CutoverVerbs_RegistryDeclarations_RejectWhatTheWaiverAccepted', () => {
    for (const id of [READINESS_ID, DECIDE_ID]) {
      const data = declaredDataSchema(id);
      expect(data.safeParse(42).success).toBe(false);
      expect(data.safeParse('report').success).toBe(false);
      expect(data.safeParse(null).success).toBe(false);
      expect(data.safeParse({}).success).toBe(false);
      expect(data.safeParse({ report: { satisfied: true } }).success).toBe(false);
    }
  });

  /** `emptyTally()` seeds all five classes. A missing class looks like a real zero, so the schema rejects a partial tally. */
  it('CutoverGateReport_PartialDisagreementTally_Rejected', () => {
    const summary: DurableEvidenceSummary = {
      featureIds: [],
      attemptCount: 0,
      dispositionTally: {},
    };
    const partial = {
      report: {
        satisfied: false,
        conditions: [{ id: 'live-observer-health', met: false, detail: 'x' }],
        unmet: ['live-observer-health'],
        unexplainedDisagreements: 0,
        liveAttemptCount: 0,
        comparableLiveAttemptCount: 0,
        nonComparableLiveAttemptCount: 0,
        liveDisagreementClasses: { agree: 0 },
        durableAttemptCount: 0,
        nonComparableDurableAttemptCount: 0,
        durableDisagreementClasses: { agree: 0 },
        observerStatus: 'unobserved',
        coveredPhaseKinds: [],
        missingPhaseKinds: [],
        hasAllowOutcome: false,
        hasDenyOutcome: false,
      },
      durableEvidence: summary,
    };
    expect(CutoverReadinessData.safeParse(partial).success).toBe(false);
  });

  /**
   * `satisfied` and `unmet` derive from `conditions`. The schema rejects a report that contradicts itself.
   * It accepts the two consistent shapes, so it rejects contradiction and not reports.
   */
  it('CutoverGateReport_SelfContradictoryVerdict_IsRefused', () => {
    const base = {
      unexplainedDisagreements: 0,
      liveAttemptCount: 0,
      comparableLiveAttemptCount: 0,
      nonComparableLiveAttemptCount: 0,
      liveDisagreementClasses: FULL_TALLY,
      durableAttemptCount: 0,
      nonComparableDurableAttemptCount: 0,
      durableDisagreementClasses: FULL_TALLY,
      observerStatus: 'unobserved',
      coveredPhaseKinds: [],
      missingPhaseKinds: [],
      hasAllowOutcome: false,
      hasDenyOutcome: false,
    };

    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: true,
        conditions: [{ id: 'live-observer-health', met: false, detail: 'x' }],
        unmet: ['live-observer-health'],
      }).success,
    ).toBe(false);

    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: false,
        conditions: [
          { id: 'a', met: true, detail: 'x' },
          { id: 'b', met: false, detail: 'x' },
        ],
        unmet: ['a'],
      }).success,
    ).toBe(false);

    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: false,
        conditions: [{ id: 'a', met: true, detail: 'x' }],
        unmet: [],
      }).success,
    ).toBe(false);

    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: true,
        conditions: [{ id: 'a', met: true, detail: 'x' }],
        unmet: [],
      }).success,
    ).toBe(true);
    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: false,
        conditions: [
          { id: 'a', met: true, detail: 'x' },
          { id: 'b', met: false, detail: 'x' },
        ],
        unmet: ['b'],
      }).success,
    ).toBe(true);
  });
});
