/**
 * freshness-gate — the process-level entry point that the dispatch chokepoint
 * calls before executing a mutating action (P05-04; ART-006, ART-007, ART-009,
 * ART-013).
 *
 * It ties the pieces together into a Trust-On-First-Use (TOFU) flow:
 *
 *   1. Detect install posture. A **dev checkout** SKIPS — there is no installed
 *      content to diverge from, so a source checkout / the test suite is never
 *      treated as a corrupt install.
 *   2. Collect the observed on-disk identity.
 *   3. Read the recorded expected identity (the lock). If there is **no lock**,
 *      this is a first run: RECORD the observed identity and PROCEED (bootstrap,
 *      never block).
 *   4. Otherwise compare recorded-vs-observed. Any stale/mixed dimension
 *      BLOCKS with an {@link InstallFreshnessError}-derived structured outcome.
 *
 * The evaluation is **memoized once per process**: a passing / skipped /
 * bootstrapped / degraded outcome is cached so the check runs exactly once even
 * across thousands of mutating dispatches. A BLOCKED outcome is intentionally
 * NOT cached — a genuinely stale install must keep blocking every action until
 * it is fixed, and re-evaluation is what lets a mid-session repair clear the
 * block.
 *
 * Robustness: a failure to collect or record (I/O error under an installed
 * posture) degrades to a non-blocking outcome rather than turning the freshness
 * gate itself into a new source of outages — the store-open schema guard
 * remains the hard stop for the schema dimension, and only a CONFIRMED
 * mismatch blocks here.
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

export interface FreshnessGateDeps extends IdentityDeps {
  /** State directory holding the recorded install-identity lock. */
  readonly stateDir: string;
}

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

  const recorded = readRecordedIdentity(deps.stateDir, deps);
  if (recorded === undefined) {
    // First run — Trust-On-First-Use: record the current identity, do not block.
    try {
      writeRecordedIdentity(deps.stateDir, observed, deps);
    } catch (err) {
      return { status: 'degraded', reason: `failed to record install identity: ${errorMessage(err)}` };
    }
    return { status: 'bootstrapped' };
  }

  const result = verifyInstallFreshness(recorded, observed);
  if (result.fresh) {
    return { status: 'fresh' };
  }
  const error = new InstallFreshnessError(result.mismatches);
  return { status: 'blocked', mismatches: result.mismatches, message: error.message };
}

/**
 * Evaluate install freshness, memoized once per process. Returns the outcome;
 * the caller decides how to surface a `blocked` result (dispatch maps it to a
 * structured `INSTALL_FRESHNESS_MISMATCH` ToolResult).
 */
export function evaluateInstallFreshness(deps: FreshnessGateDeps): FreshnessGateOutcome {
  if (cachedOutcome !== undefined) return cachedOutcome;
  const outcome = computeOutcome(deps);
  // Cache everything EXCEPT a hard block — a stale install must keep blocking,
  // and re-evaluation is what lets an in-session repair clear it.
  if (outcome.status !== 'blocked') {
    cachedOutcome = outcome;
  }
  return outcome;
}
