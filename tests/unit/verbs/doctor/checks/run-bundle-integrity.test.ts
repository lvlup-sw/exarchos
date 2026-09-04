/**
 * run-bundle-integrity — the doctor projection of the run-bundle
 * resolvability oracle.
 *
 * The check is a mapper over `probes.bundles.runIntegrityCheck`. What these
 * cases pin is that every verdict the oracle can return lands on a distinct,
 * honest doctor status: a sweep that checked nothing says so rather than
 * reading as clear, an incomplete sweep is not reported with the zero counts
 * its abort verdict cannot even carry, a loss of referenced bytes gets a
 * different remedy from a writer that referenced nothing, and the sweep's own
 * budget is sized under the ceiling the composer is racing it against —
 * whatever that ceiling is for this run.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import {
  runBundleIntegrity,
  sweepBudgetMs,
  SWEEP_SHARE_OF_CHECK_BUDGET,
} from '../../../../../src/verbs/doctor/checks/run-bundle-integrity.js';
import { DEFAULT_CHECK_BUDGET_MS } from '../../../../../src/verbs/doctor/probes.js';
import { RUN_BUNDLE_DIRNAME } from '../../../../../src/utils/paths.js';
import type { BundleIntegrityResult } from '../../../../../src/events/bundle/integrity.js';

function probesReturning(
  result: BundleIntegrityResult,
  overrides: { stateDir?: string; checkBudgetMs?: number } = {},
) {
  const recorded: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
  const probes = makeStubProbes({
    stateDir: overrides.stateDir ?? '/state',
    ...(overrides.checkBudgetMs !== undefined ? { checkBudgetMs: overrides.checkBudgetMs } : {}),
    bundles: {
      runIntegrityCheck: async (opts) => {
        recorded.push(opts ?? {});
        return result;
      },
    },
  });
  return { probes, recorded };
}

const CLEAR: BundleIntegrityResult = {
  ok: true,
  scannedStreamCount: 4,
  referenceCount: 7,
  preCustodySettlementCount: 0,
};

describe('run-bundle-integrity', () => {
  it('RunBundleIntegrity_EveryReferenceResolves_ReturnsPassNamingTheDenominator', async () => {
    const { probes, recorded } = probesReturning(CLEAR);
    const signal = new AbortController().signal;

    const result = await runBundleIntegrity(probes, signal);

    expect(result.category).toBe('storage');
    expect(result.name).toBe('run-bundle-integrity');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('7 run-bundle reference(s)');
    expect(result.message).toContain('4 stream(s)');
    expect(result.message).not.toContain('predate');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The sweep is handed the composer's OWN signal — not merely some signal —
    // so cancelling the doctor run stops a ledger walk already in flight.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.signal).toBe(signal);
  });

  it('RunBundleIntegrity_SweepBudget_IsDerivedFromTheBudgetInForceNotACopiedDefault', async () => {
    // At the default the sweep runs under the composer's race; under a widened
    // `doctor --timeout-ms` it widens with it; under a narrowed one it stays
    // under the ceiling too. The check reads the budget off the probe bundle,
    // which is where the composer puts the value it is actually racing.
    for (const checkBudgetMs of [DEFAULT_CHECK_BUDGET_MS, 10_000, 400]) {
      const { probes, recorded } = probesReturning(CLEAR, { checkBudgetMs });
      await runBundleIntegrity(probes, new AbortController().signal);
      const asked = recorded[0]?.timeoutMs;
      expect(asked).toBe(sweepBudgetMs(checkBudgetMs));
      expect(asked).toBeLessThan(checkBudgetMs);
    }
    expect(SWEEP_SHARE_OF_CHECK_BUDGET).toBeLessThan(1);
    // A tiny budget cannot starve the sweep to nothing.
    expect(sweepBudgetMs(1)).toBeGreaterThan(0);
  });

  it('RunBundleIntegrity_CarriesItsOwnIdentityForTheComposersTimeoutPath', () => {
    // A check that overruns the composer's race is reported under `meta`, not
    // under the function's binding name and a default category.
    expect(runBundleIntegrity.meta).toEqual({ category: 'storage', name: 'run-bundle-integrity' });
  });

  it('RunBundleIntegrity_EmptyDenominator_PassesButSaysNothingWasChecked', async () => {
    const { probes } = probesReturning({
      ok: 'empty',
      scannedStreamCount: 2,
      referenceCount: 0,
      preCustodySettlementCount: 0,
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Pass');
    // Not the same sentence as the clear verdict: a reader must be able to
    // tell "nothing to check" from "everything resolved".
    expect(result.message).toContain('nothing to check');
    expect(result.message).not.toContain('resolve to their bytes');
  });

  it('RunBundleIntegrity_PreCustodySettlements_AreCountedNotCondemned', async () => {
    // A ledger whose settlements all predate custody is the ordinary upgraded
    // install. It passes, and the message says those records were seen and
    // exempt — not that nothing was there.
    const { probes } = probesReturning({
      ok: 'empty',
      scannedStreamCount: 12,
      referenceCount: 0,
      preCustodySettlementCount: 9,
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Pass');
    expect(result.message).toContain('9 settlement record(s) predate run-bundle custody');
    expect(result.fix).toBeUndefined();
  });

  it('RunBundleIntegrity_BackendCannotEnumerate_ReturnsSkippedWithTheStoresReason', async () => {
    const { probes } = probesReturning({
      ok: 'skipped',
      reason: 'backend does not enumerate streams',
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBe('backend does not enumerate streams');
  });

  it('RunBundleIntegrity_LostBytes_ReturnsWarningNamingWhereAndWhatUnderTheBundleRoot', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const { probes } = probesReturning(
      {
        ok: false,
        scannedStreamCount: 3,
        referenceCount: 2,
        preCustodySettlementCount: 0,
        details: '2 run-bundle violation(s) across 2 reference(s) in 3 stream(s)',
        violations: [
          { kind: 'blob-missing', streamId: 'feat-a', sequence: 12, digest },
          { kind: 'unreadable-blob', streamId: 'feat-b', sequence: 3, digest, detail: 'EACCES' },
        ],
      },
      { stateDir: '/var/exarchos/state' },
    );

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('2 run-bundle violation(s)');
    expect(result.message).toContain(`blob-missing at feat-a#12 (${digest})`);
    expect(result.message).toContain(`unreadable-blob at feat-b#3 (${digest}): EACCES`);
    // The directory is derived from the one constant that owns the name.
    expect(result.fix).toContain(path.join('/var/exarchos/state', RUN_BUNDLE_DIRNAME));
    expect(result.fix).toContain('cannot be recovered');
    expect(result.fix).not.toContain('defect in that writer');
  });

  it('RunBundleIntegrity_SettlementWithoutReferences_IsAWriterDefectNotALoss', async () => {
    // Nothing is missing from disk: a settlement record written under the
    // custody contract referenced nothing. Telling the operator bytes are gone
    // would send them looking for a loss that never happened.
    const { probes } = probesReturning({
      ok: false,
      scannedStreamCount: 1,
      referenceCount: 0,
      preCustodySettlementCount: 2,
      details: '1 run-bundle violation(s) across 0 reference(s) in 1 stream(s)',
      violations: [{ kind: 'settlement-without-references', streamId: 'feat-b', sequence: 3 }],
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('settlement-without-references at feat-b#3');
    expect(result.message).toContain('2 settlement record(s) predate run-bundle custody');
    expect(result.fix).toContain('defect in that writer');
    expect(result.fix).not.toContain('cannot be recovered');
  });

  it('RunBundleIntegrity_ManyViolations_ShowsAFewAndCountsTheRest', async () => {
    const [first, ...rest] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'blob-missing' as const,
      streamId: `feat-${i}`,
      sequence: i + 1,
      digest: `sha256:${String(i).repeat(64)}`,
    }));
    if (first === undefined) throw new Error('fixture has no violation');
    const { probes } = probesReturning({
      ok: false,
      scannedStreamCount: 5,
      referenceCount: 5,
      preCustodySettlementCount: 0,
      details: '5 run-bundle violation(s) across 5 reference(s) in 5 stream(s)',
      violations: [first, ...rest],
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('feat-0#1');
    expect(result.message).toContain('feat-2#3');
    expect(result.message).not.toContain('feat-3#4');
    expect(result.message).toContain('and 2 more');
  });

  it('RunBundleIntegrity_TimedOutSweep_IsItsOwnWarningNamingTheOneKnobThatWidensIt', async () => {
    const { probes } = probesReturning({
      ok: false,
      incomplete: true,
      details: 'run-bundle integrity check timed out after 1500ms',
      violations: [],
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('did not complete');
    expect(result.message).toContain('timed out after 1500ms');
    expect(result.message).not.toContain('0 run-bundle violation');
    // The remedy is something an operator can actually do from a shipped
    // surface, and it says the counts are unknown rather than zero.
    expect(result.fix).toContain('exarchos doctor --timeout-ms');
    expect(result.fix).toContain('unknown, not zero');
  });

  it('RunBundleIntegrity_ThrownSweep_IsAFaultNotATimeout_AndKeepsWhatWasCollected', async () => {
    const { probes } = probesReturning(
      {
        ok: false,
        incomplete: true,
        details: 'run-bundle integrity sweep threw before finishing: EACCES: permission denied',
        violations: [{ kind: 'blob-missing', streamId: 'feat-a', sequence: 2, digest: `sha256:${'b'.repeat(64)}` }],
      },
      { stateDir: '/state' },
    );

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('EACCES');
    expect(result.message).toContain('found before stopping: blob-missing at feat-a#2');
    expect(result.fix).not.toContain('--timeout-ms');
    expect(result.fix).toContain(path.join('/state', RUN_BUNDLE_DIRNAME));
    expect(result.fix).toContain('readable');
  });
});
