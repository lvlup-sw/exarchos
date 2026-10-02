/**
 * The install freshness gate that dispatch runs before a mutating action. It
 * uses a trust-on-first-use (TOFU) flow:
 *
 *   1. A dev checkout skips, because it has no installed content to compare.
 *   2. Collect the observed identity on disk.
 *   3. If no lock exists, record the observed identity and proceed.
 *   4. Otherwise compare the lock with the observed identity. A stale or mixed
 *      dimension blocks.
 *
 * A failure to collect or record, or an indeterminate comparison, gives a
 * `degraded` outcome that does not block. Only a confirmed mismatch blocks.
 */

import type { FreshnessMismatch } from './freshness-check.js';
import { InstallFreshnessError, verifyInstallFreshness } from './freshness-check.js';
import type { InstallIdentity } from './install-identity.js';
import {
  collectInstallIdentity,
  detectInstallPosture,
  readRecordedIdentity,
  writeRecordedIdentity,
  type IdentityDeps,
} from './collect-identity.js';

/**
 * Deps for the gate. There is no `stateDir`, so a caller cannot add the event
 * store to the verdict. Install freshness depends only on the installed artifacts.
 */
export type FreshnessGateDeps = IdentityDeps;

/** Outcome of a freshness evaluation — discriminated on `status`. */
export type FreshnessGateOutcome =
  | { readonly status: 'skipped-dev'; readonly reason: string }
  | { readonly status: 'bootstrapped' }
  | { readonly status: 'fresh' }
  | { readonly status: 'degraded'; readonly reason: string }
  | {
      readonly status: 'blocked';
      readonly mismatches: readonly FreshnessMismatch[];
      readonly message: string;
    };

/** Process-level memo. `undefined` until first evaluation. */
let cachedOutcome: FreshnessGateOutcome | undefined;

/** Reset the process memo. Test-only — never called on the production path. */
export function resetInstallFreshnessGateForTest(): void {
  cachedOutcome = undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function computeOutcome(deps: FreshnessGateDeps): FreshnessGateOutcome {
  const posture = detectInstallPosture(deps);
  if (posture.kind === 'dev-checkout') {
    return { status: 'skipped-dev', reason: posture.reason };
  }

  let observed: InstallIdentity;
  try {
    observed = collectInstallIdentity(posture.pluginRoot, deps);
  } catch (err) {
    return { status: 'degraded', reason: `install-identity collection failed: ${errorMessage(err)}` };
  }

  const recorded = readRecordedIdentity(posture.pluginRoot, deps);
  if (recorded === undefined) {
    try {
      writeRecordedIdentity(posture.pluginRoot, observed, deps);
    } catch (err) {
      return { status: 'degraded', reason: `failed to record install identity: ${errorMessage(err)}` };
    }
    return { status: 'bootstrapped' };
  }

  const result = verifyInstallFreshness(recorded, observed);
  if (result.fresh) {
    return { status: 'fresh' };
  }
  if ('indeterminate' in result) {
    return { status: 'degraded', reason: result.reason };
  }
  const error = new InstallFreshnessError(result.mismatches);
  return { status: 'blocked', mismatches: result.mismatches, message: error.message };
}

/**
 * Evaluate install freshness once per process. The memo keeps each outcome
 * except `blocked`, so a stale install blocks each action until a repair clears
 * it. Dispatch maps `blocked` to an `INSTALL_FRESHNESS_MISMATCH` result.
 */
export function evaluateInstallFreshness(deps: FreshnessGateDeps): FreshnessGateOutcome {
  if (cachedOutcome !== undefined) return cachedOutcome;
  const outcome = computeOutcome(deps);
  if (outcome.status !== 'blocked') {
    cachedOutcome = outcome;
  }
  return outcome;
}
