/**
 * run-bundle-integrity — the run-bundle resolvability oracle, reachable.
 *
 * The oracle (`EventStore.runBundleIntegrityCheck`) walks every stream and
 * re-hashes every referenced bundle blob; nothing on the append or replay path
 * may pay that, so it runs only when a caller asks. This check is that caller
 * on every doctor path — the read-only diagnosis, `doctor --fix` and
 * `onboard`. Until the executor began writing bundles the sweep had nothing
 * to find and no one to run it; now that a settled operation names bytes by
 * digest, a blob deleted or corrupted after settlement is exactly what the
 * claim fast path cannot see and this check can.
 *
 * Verdict mapping, and why each lands where it does:
 *   - `true`     → Pass, naming the denominator it checked and how many
 *                  settlements predate custody (seen, exempt, not checked).
 *   - `'empty'`  → Pass, saying so explicitly. A sweep that examined nothing
 *                  is not a sweep that found nothing wrong; the message keeps
 *                  the two apart even though the status cannot.
 *   - `'skipped'`→ Skipped with the store's reason (the backend cannot
 *                  enumerate streams).
 *   - `false`    → Warning, with a remedy that depends on WHAT was found: a
 *                  referenced blob missing, corrupt or unreadable is a loss of
 *                  the run's interior — the operation record stays
 *                  authoritative and nothing can bring the bytes back — while
 *                  a custodial settlement that references nothing, or a
 *                  reference nobody can parse, is a defect in a writer, not a
 *                  loss. Both are Warnings rather than Fails because neither
 *                  is an install fault an operator can repair; the finding is
 *                  named on the `diagnostic.executed` row instead so the
 *                  ledger carries it. `incomplete` is reported as its own
 *                  verdict — a timeout names the one knob that widens it, a
 *                  thrown sweep names the fault — because its counts are
 *                  unknown rather than zero.
 *
 * The sweep budget is derived from the per-check budget the composer is
 * racing this check against, so the check's own honest "did not finish"
 * reaches the operator instead of the composer's generic timeout — at the
 * default and under `doctor --timeout-ms` alike.
 */

import path from 'node:path';

import type { BundleViolation } from '../../../events/bundle/integrity.js';
import { RUN_BUNDLE_DIRNAME } from '../../../utils/paths.js';
import type { DoctorProbes } from '../probes.js';
import type { CheckResult } from '../schema.js';

/**
 * The share of the composer's per-check budget the sweep may spend. Under one,
 * so the sweep's timeout fires — and its `incomplete` verdict is returned —
 * before the composer's race declares a generic timeout for this check.
 */
export const SWEEP_SHARE_OF_CHECK_BUDGET = 0.75;

/** The least the sweep is ever given, so a tiny budget cannot starve it to nothing. */
const MINIMUM_SWEEP_BUDGET_MS = 100;

export function sweepBudgetMs(checkBudgetMs: number): number {
  return Math.max(MINIMUM_SWEEP_BUDGET_MS, Math.floor(checkBudgetMs * SWEEP_SHARE_OF_CHECK_BUDGET));
}

const SHOWN_VIOLATIONS = 3;

/** Violations that mean referenced bytes are not what the ledger says they are. */
const LOSS_KINDS: ReadonlySet<BundleViolation['kind']> = new Set([
  'blob-missing',
  'digest-mismatch',
  'unreadable-blob',
]);

function describeViolation(violation: BundleViolation): string {
  const where = `${violation.streamId}#${violation.sequence}`;
  const digest = violation.digest === undefined ? '' : ` (${violation.digest})`;
  const detail = violation.detail === undefined ? '' : `: ${violation.detail}`;
  return `${violation.kind} at ${where}${digest}${detail}`;
}

const CHECK_IDENTITY = { category: 'storage', name: 'run-bundle-integrity' } satisfies Pick<
  CheckResult,
  'category' | 'name'
>;

async function runBundleIntegrityCheck(
  probes: DoctorProbes,
  signal: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  const result = await probes.bundles.runIntegrityCheck({
    signal,
    timeoutMs: sweepBudgetMs(probes.checkBudgetMs),
  });
  const durationMs = Date.now() - started;

  const base = { ...CHECK_IDENTITY, durationMs };
  const bundleRoot = path.join(probes.stateDir, RUN_BUNDLE_DIRNAME);

  if (result.ok === true) {
    return {
      ...base,
      status: 'Pass',
      message:
        `${result.referenceCount} run-bundle reference(s) across ` +
        `${result.scannedStreamCount} stream(s) resolve to their bytes` +
        preCustodyNote(result.preCustodySettlementCount),
    };
  }
  if (result.ok === 'empty') {
    return {
      ...base,
      status: 'Pass',
      message:
        `nothing to check: ${result.scannedStreamCount} stream(s) carry no run-bundle ` +
        'references and no settlement under custody' +
        preCustodyNote(result.preCustodySettlementCount),
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
    const timedOut = /timed out/.test(result.details);
    return {
      ...base,
      status: 'Warning',
      message:
        `run-bundle integrity sweep did not complete: ${result.details}` +
        (result.violations.length > 0
          ? `; found before stopping: ${result.violations.map(describeViolation).join('; ')}`
          : ''),
      fix: timedOut
        ? 'Re-run with a larger per-check budget (`exarchos doctor --timeout-ms <ms>`; the ' +
          `sweep runs at ${Math.round(SWEEP_SHARE_OF_CHECK_BUDGET * 100)}% of it) — the counts on ` +
          'an incomplete sweep are unknown, not zero'
        : `The sweep threw before finishing. Check that ${bundleRoot} and the event store are ` +
          'readable, then re-run — the counts on an incomplete sweep are unknown, not zero',
    };
  }

  const shown = result.violations.slice(0, SHOWN_VIOLATIONS).map(describeViolation);
  const more = result.violations.length - shown.length;
  const losses = result.violations.filter((violation) => LOSS_KINDS.has(violation.kind)).length;
  const defects = result.violations.length - losses;
  const remedies: string[] = [];
  if (losses > 0) {
    remedies.push(
      `${losses} referenced bundle blob(s) under ${bundleRoot} are missing, corrupt or unreadable. ` +
        'The operation records that reference them stay authoritative; the interior trace they ' +
        'name cannot be recovered. Do not delete or hand-edit that directory — the ledger ' +
        'references its contents by digest.',
    );
  }
  if (defects > 0) {
    remedies.push(
      `${defects} settlement record(s) written under the custody contract reference nothing ` +
        'readable. No bytes were lost; a writer committed a settlement without putting its ' +
        'bundle first, which is a defect in that writer.',
    );
  }
  return {
    ...base,
    status: 'Warning',
    message:
      `${result.details}: ${shown.join('; ')}` +
      (more > 0 ? `; and ${more} more` : '') +
      preCustodyNote(result.preCustodySettlementCount),
    fix: remedies.join(' '),
  };
}

function preCustodyNote(count: number): string {
  return count > 0
    ? `; ${count} settlement record(s) predate run-bundle custody and were not checked`
    : '';
}

/**
 * The check, carrying its own identity for the composer's timeout path: a
 * check that overruns the composer's race is reported under the name and
 * category it declares, not under the function's binding name and a default
 * category.
 */
export const runBundleIntegrity = Object.assign(runBundleIntegrityCheck, { meta: CHECK_IDENTITY });
