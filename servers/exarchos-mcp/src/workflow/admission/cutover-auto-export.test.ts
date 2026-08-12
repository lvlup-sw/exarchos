// ─── #1739 — cutover readiness auto-export tests ─────────────────────────────
//
// The load-bearing claims:
//   * FIRST satisfaction exports: the report lands atomically at
//     `<stateDir>/admission/cutover-readiness.json` AND exactly one
//     `admission.cutover-ready` fact is appended;
//   * the cheap pre-filter is real: below MINIMUM_LIVE_ATTEMPTS observed
//     attempts the durable reader is NEVER touched;
//   * repeats after readiness do not duplicate the fact — the in-memory latch
//     short-circuits, and even across a simulated restart (latch reset) the
//     DETERMINISTIC store-identity idempotency key collapses the re-append
//     onto the stored row (T-49: nothing clock- or random-derived).

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADMISSION_STREAM_ID } from '../../core/infra-streams.js';
import { EventStore } from '../../events/store.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  type LiveShadowAttempt,
} from './cutover-gate.js';
import {
  configureCutoverAutoExport,
  cutoverAutoExportDiagnostics,
  cutoverReadinessIdempotencyKey,
  flushCutoverAutoExport,
  maybeExportCutoverReadiness,
} from './cutover-auto-export.js';
import type { ShadowEvidenceSource } from './evidence-reader.js';
import type { LiveShadowHealth } from './live-shadow-observer.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AT = '2026-07-21T20:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const digest = () => ({ algorithm: 'sha256' as const, value: SHA_A });

const caller = {
  principalKind: 'service' as const,
  principalId: 'exarchos.live-shadow-observer',
  role: 'shadow-observer',
};
const authorization = {
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
    caller,
    authorization,
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

function healthWithAttempts(attemptsObserved: number): LiveShadowHealth {
  return {
    attemptsObserved,
    appendsScheduled: attemptsObserved,
    appendsSucceeded: attemptsObserved,
    appendsFailed: 0,
    streamUnresolved: 0,
    observationsThrew: 0,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('CutoverAutoExport (#1739)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'exarchos-cutover-export-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    configureCutoverAutoExport(undefined);
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

  function configureSatisfiable(): void {
    configureCutoverAutoExport({
      store: eventStore,
      stateDir,
      liveAttempts: () => satisfiableLiveAttempts(),
      observerHealth: () =>
        healthWithAttempts(satisfiableLiveAttempts().length),
      now: () => AT,
    });
  }

  it('AutoExport_ThresholdFirstSatisfied_WritesReportAndAppendsEventOnce', async () => {
    await seedSatisfiableDurableEvidence();
    configureSatisfiable();

    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();

    // The report artifact landed, and it is the SATISFIED report.
    const reportPath = join(stateDir, 'admission', 'cutover-readiness.json');
    expect(existsSync(reportPath)).toBe(true);
    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      recordedAt: string;
      report: { satisfied: boolean; unmet: readonly string[] };
    };
    expect(written.report.satisfied).toBe(true);
    expect(written.report.unmet).toEqual([]);

    // Exactly ONE readiness fact, carrying the deterministic identity.
    const events = await eventStore.query(ADMISSION_STREAM_ID, {
      type: 'admission.cutover-ready',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      readinessId: cutoverReadinessIdempotencyKey(stateDir),
      reportPath,
      observerStatus: 'healthy',
    });
    expect(cutoverAutoExportDiagnostics()).toMatchObject({
      exported: true,
      failures: 0,
    });
  });

  it('AutoExport_BelowPrefilter_NeverRunsFullEvaluation', async () => {
    let durableReads = 0;
    const spyStore: ShadowEvidenceSource & {
      append: EventStore['append'];
    } = {
      listStreams: () => {
        durableReads += 1;
        return [];
      },
      query: async () => {
        durableReads += 1;
        return [];
      },
      append: (...args) => eventStore.append(...args),
    };
    configureCutoverAutoExport({
      store: spyStore,
      stateDir,
      liveAttempts: () => satisfiableLiveAttempts(),
      // One short of the threshold: the pre-filter must refuse BEFORE any
      // durable read.
      observerHealth: () => healthWithAttempts(MINIMUM_LIVE_ATTEMPTS - 1),
      now: () => AT,
    });

    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();

    expect(durableReads).toBe(0);
    expect(cutoverAutoExportDiagnostics()).toMatchObject({
      exported: false,
      evaluations: 0,
      failures: 0,
    });
    expect(
      existsSync(join(stateDir, 'admission', 'cutover-readiness.json')),
    ).toBe(false);
  });

  it('AutoExport_RepeatAttemptsAfterReady_DoNotDuplicateEvent', async () => {
    await seedSatisfiableDurableEvidence();
    configureSatisfiable();

    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();
    const afterFirst = cutoverAutoExportDiagnostics();
    expect(afterFirst.exported).toBe(true);

    // Same-process repeats: the latch short-circuits before any evaluation.
    maybeExportCutoverReadiness();
    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();
    expect(cutoverAutoExportDiagnostics().evaluations).toBe(
      afterFirst.evaluations,
    );

    // Simulated RESTART: reconfigure resets the in-memory latch, so the hook
    // re-evaluates and re-appends — and the deterministic store-identity key
    // collapses that append onto the stored row (INV-8 / T-49).
    configureSatisfiable();
    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();

    const events = await eventStore.query(ADMISSION_STREAM_ID, {
      type: 'admission.cutover-ready',
    });
    expect(events).toHaveLength(1);
  });
});
