// Tests for the cutover readiness auto-export. The first satisfied evaluation
// writes `<stateDir>/admission/cutover-readiness.json` and appends one
// `admission.cutover-ready` event. Below MINIMUM_LIVE_ATTEMPTS observed
// attempts, the export does not read the durable store. After readiness, a
// repeat appends no second event. An in-memory latch stops repeats in one
// process. After a restart, an idempotency key from the store identity merges
// the new append into the stored row.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADMISSION_STREAM_ID } from '../../../../src/dispatch/core/infra-streams.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  type LiveShadowAttempt,
} from '../../../../src/workflow/admission/cutover-gate.js';
import {
  configureCutoverAutoExport,
  cutoverAutoExportDiagnostics,
  cutoverReadinessIdempotencyKey,
  flushCutoverAutoExport,
  maybeExportCutoverReadiness,
} from '../../../../src/workflow/admission/cutover-auto-export.js';
import type { ShadowEvidenceSource } from '../../../../src/workflow/admission/evidence-reader.js';
import type { LiveShadowHealth } from '../../../../src/workflow/admission/live-shadow-observer.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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

    const reportPath = join(stateDir, 'admission', 'cutover-readiness.json');
    expect(existsSync(reportPath)).toBe(true);
    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      recordedAt: string;
      report: { satisfied: boolean; unmet: readonly string[] };
    };
    expect(written.report.satisfied).toBe(true);
    expect(written.report.unmet).toEqual([]);

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

  /** One attempt below the threshold, the pre-filter stops the export before any durable read. */
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

  /**
   * In one process, the latch stops a repeat before evaluation. A reconfigure
   * resets the latch like a restart, and the deterministic key merges the second
   * append into the stored row.
   */
  it('AutoExport_RepeatAttemptsAfterReady_DoNotDuplicateEvent', async () => {
    await seedSatisfiableDurableEvidence();
    configureSatisfiable();

    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();
    const afterFirst = cutoverAutoExportDiagnostics();
    expect(afterFirst.exported).toBe(true);

    maybeExportCutoverReadiness();
    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();
    expect(cutoverAutoExportDiagnostics().evaluations).toBe(
      afterFirst.evaluations,
    );

    configureSatisfiable();
    maybeExportCutoverReadiness();
    await flushCutoverAutoExport();

    const events = await eventStore.query(ADMISSION_STREAM_ID, {
      type: 'admission.cutover-ready',
    });
    expect(events).toHaveLength(1);
  });
});
