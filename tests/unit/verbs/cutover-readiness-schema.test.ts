// ─── Task 083 — the cutover verbs' paydown ───────────────────────────────────
//
// Four claims, and none of them is "the file changed":
//
//   1. SUBSTANCE. `cutover_readiness` and `cutover_decide` no longer declare a
//      vacuous `outputSchema`. Measured by the live census, which walks the Zod
//      objects the registry constructs — not by grepping for `vacuityWaiver`.
//   2. THE ROW WENT OFF, NOT SIDEWAYS. Both ids left `VACUITY_ALLOWLIST` and
//      landed in `VACUITY_RETIRED`, so the seed key set — the quantity the pin
//      freezes — is unchanged. A paydown recorded as a DELETION would move it.
//   3. THE RATCHET STILL HAS TEETH IN BOTH DIRECTIONS. It accepts a further
//      MOVE, and rejects an ADDITION, a DELETION, and the sideways "keep the
//      waiver anyway" edit. A shrink-only claim nobody has seen refuse a growth
//      is the same presence-not-substance defect DR-4 exists to remove.
//   4. THE CONTRACT IS HONEST. The declarations the registry now carries accept
//      what the handlers really emit (so the MCP D.5 validator cannot turn a
//      correct response into an INTERNAL_ERROR) and reject what the vacuous
//      schema used to wave through.
//
// @oracle-sources: ../../../src/registry.ts, ../../../tools/conformance/src/output-schema-seed-pin.ts

import { mkdtemp, rm } from 'node:fs/promises';
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

// ─── Fixtures for the live-handler arm ───────────────────────────────────────

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

// ─── 1. Substance ────────────────────────────────────────────────────────────

/** All five disagreement classes seeded, as `emptyTally()` produces them. */
const FULL_TALLY: Record<string, number> = Object.fromEntries(
  DISAGREEMENT_CLASSES.map((c) => [c, 0]),
);

describe('Task 083 — the cutover verbs declare substantive outputSchemas', () => {
  it('CutoverVerbs_LiveCensus_ClassifiesBothSubstantive', () => {
    // Read through the census, which walks the constructed Zod object. A grep
    // for `vacuityWaiver` would agree with a laundered alias; this does not.
    for (const id of [READINESS_ID, DECIDE_ID]) {
      const verdict = classifyOutputSchema(declaredOutputSchema(id), OUTPUT_SCHEMA_PORTS);
      expect(verdict.classification).toBe('substantive');
      expect(verdict.reason).toBe('typed-data');
    }
  });

  it('CutoverVerbs_CensusVacuousPopulation_ExcludesBoth', () => {
    const census = censusLiveOutputSchemas();
    // Non-empty denominator first: a census that lost its subject would make
    // every exclusion below true for the worst possible reason.
    expect(census.total).toBeGreaterThan(0);
    expect(census.ok).toBe(true);
    expect(census.vacuous).not.toContain(READINESS_ID);
    expect(census.vacuous).not.toContain(DECIDE_ID);
    expect(census.substantive).toContain(READINESS_ID);
    expect(census.substantive).toContain(DECIDE_ID);
  });
});

// ─── 2. The rows went OFF, not sideways ──────────────────────────────────────

describe('Task 083 — the waiver rows left the allowlist', () => {
  it('CutoverVerbs_WaiverSeed_MovedFromAllowlistToRetired', () => {
    expect(VACUITY_ALLOWLIST_IDS).not.toContain(READINESS_ID);
    expect(VACUITY_ALLOWLIST_IDS).not.toContain(DECIDE_ID);
    expect(VACUITY_RETIRED_IDS).toContain(READINESS_ID);
    expect(VACUITY_RETIRED_IDS).toContain(DECIDE_ID);
    // The shrink, stated as a number so a silent re-add is visible. The seed
    // was 112 ids; four are now retired — the fourth is `stack_place`, whose
    // re-parenting onto `exarchos_orchestrate` could not carry its waiver across
    // (a waiver is keyed by action id, and swapping one seeded key for another
    // is what the seed digest reddens), so the debt was paid instead.
    expect(VACUITY_ALLOWLIST_IDS.length).toBe(108);
    expect(VACUITY_RETIRED_IDS.length).toBe(4);
  });

  it('CutoverVerbs_SeedKeySet_UnchangedBecausePaydownIsAMove', () => {
    // The pin is the SECOND authority: `output-schema-seed-pin.ts` imports
    // nothing, so it cannot observe the seed it pins. A paydown recorded as a
    // deletion would break this; a move does not.
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

// ─── 3. The ratchet accepts a SHRINK and refuses a GROWTH ────────────────────

describe('Task 083 — the shrink-only ratchet, exercised in both directions', () => {
  // Any live waiver will do as the subject of a hypothetical NEXT paydown.
  const someLiveWaiver = VACUITY_ALLOWLIST_IDS[0] ?? '';

  it('VacuityRatchet_FurtherPaydownAsAMove_Accepted', () => {
    expect(someLiveWaiver.length).toBeGreaterThan(0);
    const verdict = auditLiveVacuitySeedIntegrity(
      VACUITY_ALLOWLIST_IDS.filter((id) => id !== someLiveWaiver),
      [...VACUITY_RETIRED_IDS, someLiveWaiver],
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
    // A move cannot change the seed's size — that is what makes the pin usable.
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

  it('VacuityRatchet_WaiverKeptSideways_RejectedAsStale', () => {
    // The "sideways" edit task 083 was told not to make: fix the schema but
    // leave the waiver standing. Membership catches it because the declaration
    // is no longer vacuous, so the waiver has nothing left to waive.
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

// ─── 4. The contract is honest about what the handlers emit ──────────────────

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
    await rm(stateDir, { recursive: true, force: true });
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

  it('CutoverReadiness_ColdStoreEmission_ParsesAgainstTheRegistryDeclaration', async () => {
    const result = await handleCutoverReadiness({}, stateDir, eventStore, EMPTY_DEPS);
    expect(result.success).toBe(true);

    // The module-level contract…
    const direct = CutoverReadinessData.safeParse(result.data);
    expect(direct.error?.message).toBeUndefined();
    expect(direct.success).toBe(true);

    // …and the schema the REGISTRY actually advertises, which is that contract
    // after `withCappedShape` unioned the capped fallback in. Both must accept
    // the emission, or the D.5 validator turns a correct response into an
    // INTERNAL_ERROR.
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

  it('CutoverVerbs_RegistryDeclarations_RejectWhatTheWaiverAccepted', () => {
    // A vacuous `data` (`z.unknown()`) accepted every one of these. The point
    // of the paydown is that they now fail at the boundary.
    for (const id of [READINESS_ID, DECIDE_ID]) {
      const data = declaredDataSchema(id);
      expect(data.safeParse(42).success).toBe(false);
      expect(data.safeParse('report').success).toBe(false);
      expect(data.safeParse(null).success).toBe(false);
      expect(data.safeParse({}).success).toBe(false);
      // A report-shaped payload missing the field the caller branches on.
      expect(data.safeParse({ report: { satisfied: true } }).success).toBe(false);
    }
  });

  it('CutoverGateReport_PartialDisagreementTally_Rejected', () => {
    // The tally's five classes are always present (`emptyTally()` seeds them),
    // and a class that silently stopped being counted is indistinguishable
    // from a genuine zero — so a partial tally is refused rather than read as
    // "four classes, all fine".
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

  it('CutoverGateReport_SelfContradictoryVerdict_IsRefused', () => {
    // `unmet` and `satisfied` are derivable from `conditions`, and every field
    // was individually valid while the document as a whole disagreed with
    // itself. The header says the everything-is-met reading must not cross the
    // boundary as a clean one — a `satisfied: true` beside a failing condition
    // is exactly that reading.
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

    // satisfied: true, but a condition failed.
    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: true,
        conditions: [{ id: 'live-observer-health', met: false, detail: 'x' }],
        unmet: ['live-observer-health'],
      }).success,
    ).toBe(false);

    // `unmet` names a condition that was MET, and omits the one that was not.
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

    // satisfied: false with nothing unmet is the mirror contradiction.
    expect(
      CutoverGateReportSchema.safeParse({
        ...base,
        satisfied: false,
        conditions: [{ id: 'a', met: true, detail: 'x' }],
        unmet: [],
      }).success,
    ).toBe(false);

    // …and the two CONSISTENT shapes still parse, so this rejects contradiction
    // rather than rejecting reports.
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
