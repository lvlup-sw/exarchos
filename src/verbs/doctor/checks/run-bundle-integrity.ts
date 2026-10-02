/**
 * run-bundle-integrity: the doctor check that runs the run-bundle integrity
 * sweep (`EventStore.runBundleIntegrityCheck`). The sweep re-hashes every
 * referenced bundle blob, so it runs only on request, never on append or
 * replay. It finds a blob that is missing or corrupt after settlement.
 *
 * `true` and `'empty'` give Pass, and the message keeps "nothing to check"
 * apart from "nothing wrong". `'skipped'` gives Skipped with the reason from
 * the store. An incomplete sweep gives Warning, because its counts are unknown.
 * `false` gives Warning, not Fail, because neither a lost blob nor a writer
 * defect is an install fault that an operator can repair.
 */

import path from 'node:path';

import type { BundleViolation } from '../../../events/bundle/integrity.js';
import { RUN_BUNDLE_DIRNAME } from '../../../utils/paths.js';
import type { DoctorProbes } from '../probes.js';
import type { CheckResult } from '../schema.js';

/**
 * The share of the per-check budget of the composer that the sweep can spend.
 * It is less than one, so the sweep times out and returns its `incomplete`
 * verdict before the composer declares a generic timeout for this check.
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
 * The check with its identity attached. If the check overruns the composer's
 * race, the composer reports the timeout under this name and category.
 */
export const runBundleIntegrity = Object.assign(runBundleIntegrityCheck, { meta: CHECK_IDENTITY });
