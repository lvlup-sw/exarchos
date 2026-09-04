/**
 * run-bundle-integrity — the doctor projection of the run-bundle
 * resolvability oracle.
 *
 * The check is a mapper over `probes.bundles.runIntegrityCheck`. What these
 * cases pin is that every verdict the oracle can return lands on a distinct,
 * honest doctor status: a sweep that checked nothing says so rather than
 * reading as clear, an incomplete sweep is not reported with the zero counts
 * its abort verdict carries, and a violation names where it is.
 */

import { describe, it, expect } from 'vitest';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import {
  runBundleIntegrity,
  RUN_BUNDLE_INTEGRITY_TIMEOUT_MS,
} from '../../../../../src/verbs/doctor/checks/run-bundle-integrity.js';
import type { BundleIntegrityResult } from '../../../../../src/events/bundle/integrity.js';

function probesReturning(result: BundleIntegrityResult, stateDir = '/state') {
  const recorded: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
  const probes = makeStubProbes({
    stateDir,
    bundles: {
      runIntegrityCheck: async (opts) => {
        recorded.push(opts ?? {});
        return result;
      },
    },
  });
  return { probes, recorded };
}

describe('run-bundle-integrity', () => {
  it('RunBundleIntegrity_EveryReferenceResolves_ReturnsPassNamingTheDenominator', async () => {
    const { probes, recorded } = probesReturning({
      ok: true,
      scannedStreamCount: 4,
      referenceCount: 7,
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.category).toBe('storage');
    expect(result.name).toBe('run-bundle-integrity');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('7 run-bundle reference(s)');
    expect(result.message).toContain('4 stream(s)');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The sweep is asked to finish under the composer's own per-check budget,
    // so its `incomplete` verdict is what the operator sees on a slow store,
    // not the composer's generic timeout Warning.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.timeoutMs).toBe(RUN_BUNDLE_INTEGRITY_TIMEOUT_MS);
    expect(RUN_BUNDLE_INTEGRITY_TIMEOUT_MS).toBeLessThan(2000);
    expect(recorded[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('RunBundleIntegrity_EmptyDenominator_PassesButSaysNothingWasChecked', async () => {
    const { probes } = probesReturning({ ok: 'empty', scannedStreamCount: 2, referenceCount: 0 });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Pass');
    // Not the same sentence as the clear verdict: a reader must be able to
    // tell "nothing to check" from "everything resolved".
    expect(result.message).toContain('nothing to check');
    expect(result.message).not.toContain('resolve to their bytes');
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

  it('RunBundleIntegrity_Violations_ReturnsWarningNamingWhereAndWhat', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const { probes } = probesReturning(
      {
        ok: false,
        scannedStreamCount: 3,
        referenceCount: 2,
        details: '2 run-bundle violation(s) across 2 reference(s) in 3 stream(s)',
        violations: [
          { kind: 'blob-missing', streamId: 'feat-a', sequence: 12, digest },
          { kind: 'settled-stream-without-references', streamId: 'feat-b', sequence: 3 },
        ],
      },
      '/var/exarchos/state',
    );

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('2 run-bundle violation(s)');
    expect(result.message).toContain(`blob-missing at feat-a#12 (${digest})`);
    expect(result.message).toContain('settled-stream-without-references at feat-b#3');
    expect(result.fix).toContain('/var/exarchos/state/run-bundles');
    expect(result.fix).toContain('cannot be recovered');
  });

  it('RunBundleIntegrity_ManyViolations_ShowsAFewAndCountsTheRest', async () => {
    const violations = Array.from({ length: 5 }, (_, i) => ({
      kind: 'blob-missing' as const,
      streamId: `feat-${i}`,
      sequence: i + 1,
      digest: `sha256:${String(i).repeat(64)}`,
    }));
    const { probes } = probesReturning({
      ok: false,
      scannedStreamCount: 5,
      referenceCount: 5,
      details: '5 run-bundle violation(s) across 5 reference(s) in 5 stream(s)',
      violations,
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('feat-0#1');
    expect(result.message).toContain('feat-2#3');
    expect(result.message).not.toContain('feat-3#4');
    expect(result.message).toContain('and 2 more');
  });

  it('RunBundleIntegrity_IncompleteSweep_IsItsOwnWarningNotAZeroCountVerdict', async () => {
    const { probes } = probesReturning({
      ok: false,
      scannedStreamCount: 0,
      referenceCount: 0,
      details: 'run-bundle integrity check timed out after 1500ms',
      violations: [],
      incomplete: true,
    });

    const result = await runBundleIntegrity(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('did not complete');
    expect(result.message).toContain('timed out after 1500ms');
    // The abort verdict carries placeholder zeroes; the check must not read
    // them as a measured clean sweep of nothing.
    expect(result.message).not.toContain('0 run-bundle violation');
    expect(result.fix).toContain('unknown, not zero');
  });
});
