/**
 * run-bundle-integrity — the run-bundle resolvability oracle, reachable.
 *
 * The oracle (`EventStore.runBundleIntegrityCheck`) walks every stream and
 * re-hashes every referenced bundle blob; nothing on the append or replay path
 * may pay that, so it runs only when a caller asks. This check is that caller.
 * Until the executor began writing bundles the sweep had nothing to find and
 * no one to run it; now that a settled operation names bytes by digest, a
 * blob deleted or corrupted after settlement is exactly what the claim fast
 * path cannot see and this check can.
 *
 * Verdict mapping, and why each lands where it does:
 *   - `true`     → Pass, naming the denominator it checked.
 *   - `'empty'`  → Pass, saying so explicitly. A sweep that examined nothing
 *                  is not a sweep that found nothing wrong; the message keeps
 *                  the two apart even though the status cannot.
 *   - `'skipped'`→ Skipped with the store's reason (the backend cannot
 *                  enumerate streams).
 *   - `false`    → Warning. Custody violations are a durable record of loss,
 *                  not an install fault an operator can repair — the bytes
 *                  are gone — so the sibling sqlite-corruption check's
 *                  convention applies. `incomplete` (timed out or threw before
 *                  finishing) is reported as its own Warning with a rerun hint,
 *                  because its counts are unknown rather than zero.
 */

import type { BundleViolation } from '../../../events/bundle/integrity.js';
import type { DoctorProbes } from '../probes.js';
import type { CheckResult } from '../schema.js';

/**
 * Under the composer's own per-check ceiling, so the sweep's honest
 * `incomplete` verdict reaches the operator instead of the composer's generic
 * "did not complete" Warning racing it.
 */
export const RUN_BUNDLE_INTEGRITY_TIMEOUT_MS = 1500;

const SHOWN_VIOLATIONS = 3;

function describeViolation(violation: BundleViolation): string {
  const where = `${violation.streamId}#${violation.sequence}`;
  return violation.digest === undefined
    ? `${violation.kind} at ${where}`
    : `${violation.kind} at ${where} (${violation.digest})`;
}

export async function runBundleIntegrity(
  probes: DoctorProbes,
  signal: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  const result = await probes.bundles.runIntegrityCheck({
    signal,
    timeoutMs: RUN_BUNDLE_INTEGRITY_TIMEOUT_MS,
  });
  const durationMs = Date.now() - started;

  const base = { category: 'storage' as const, name: 'run-bundle-integrity', durationMs };

  if (result.ok === true) {
    return {
      ...base,
      status: 'Pass',
      message:
        `${result.referenceCount} run-bundle reference(s) across ` +
        `${result.scannedStreamCount} stream(s) resolve to their bytes`,
    };
  }
  if (result.ok === 'empty') {
    return {
      ...base,
      status: 'Pass',
      message:
        `nothing to check: ${result.scannedStreamCount} stream(s) carry no run-bundle ` +
        'references and no settled operation',
    };
  }
  if (result.ok === 'skipped') {
    return {
      ...base,
      status: 'Skipped',
      message: 'run-bundle integrity check skipped',
      reason: result.reason,
    };
  }
  if (result.incomplete === true) {
    return {
      ...base,
      status: 'Warning',
      message: `run-bundle integrity sweep did not complete: ${result.details}`,
      fix:
        'Re-run the sweep with a larger budget (EventStore.runBundleIntegrityCheck ' +
        '{ timeoutMs }) — the counts on an incomplete sweep are unknown, not zero',
    };
  }

  const shown = result.violations.slice(0, SHOWN_VIOLATIONS).map(describeViolation);
  const more = result.violations.length - shown.length;
  return {
    ...base,
    status: 'Warning',
    message:
      `${result.details}: ${shown.join('; ')}` + (more > 0 ? `; and ${more} more` : ''),
    fix:
      `Bundle bytes referenced from the ledger are missing or corrupt under ${probes.stateDir}/run-bundles. ` +
      'The referencing operation records stay authoritative; the interior trace they name cannot be recovered. ' +
      'Do not delete or hand-edit run-bundles/ — the ledger references its contents by digest.',
  };
}
