/**
 * install-freshness (P05-04) — read-only visibility into the install-identity
 * freshness gate. Diagnoses exactly the "upgraded the binary but kept a stale
 * plugin / skill / cache directory" case that the dispatch chokepoint BLOCKS at
 * runtime, so an operator can see *which* dimension is stale before hitting the
 * block.
 *
 * Strictly read-only and non-mutating: unlike the dispatch gate it never writes
 * a bootstrap lock and never throws — a missing lock (first run) or a dev
 * checkout is a benign `Pass`, an unreadable install or a confirmed mismatch is
 * a `Warning` carrying per-dimension remediation. It mirrors the gate's
 * comparison (`verifyInstallFreshness`) so doctor and dispatch agree on what
 * "stale" means.
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';
import {
  detectInstallPosture,
  collectInstallIdentity,
  readRecordedIdentity,
  installIdentityLockPath,
} from '../../../install/collect-identity.js';
import { verifyInstallFreshness } from '../../../install/freshness-check.js';

export async function installFreshness(
  probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  const start = Date.now();
  const base = { category: 'plugin' as const, name: 'install-freshness' };
  const deps = { env: probes.env } as const;

  const posture = detectInstallPosture(deps);
  if (posture.kind === 'dev-checkout') {
    return {
      ...base,
      status: 'Pass',
      message: `Running from source (${posture.reason}); install-freshness gating is not applicable.`,
      durationMs: Date.now() - start,
    };
  }

  let observedSummary: string;
  try {
    const observed = collectInstallIdentity(posture.pluginRoot, deps);
    observedSummary = `binary ${observed.binary.version}, schema v${observed.schema.version}`;

    const recorded = readRecordedIdentity(posture.pluginRoot, deps);
    if (recorded === undefined) {
      return {
        ...base,
        status: 'Pass',
        message:
          `Installed (${posture.source}) at ${posture.pluginRoot}; no recorded install identity yet — ` +
          `the first mutating action records a baseline at ${installIdentityLockPath(posture.pluginRoot, deps)}.`,
        durationMs: Date.now() - start,
      };
    }

    const result = verifyInstallFreshness(recorded, observed);
    if (!result.fresh && 'indeterminate' in result) {
      // Never claim five dimensions match while two of them are unknown.
      return {
        ...base,
        status: 'Warning',
        message: `Installation freshness is UNDETERMINED (${observedSummary}). ${result.reason}`,
        fix:
          `Reinstall via scripts/get-exarchos.{sh,ps1} so the install carries a readable ` +
          `version, or verify ${posture.pluginRoot}/package.json is present and readable.`,
        durationMs: Date.now() - start,
      };
    }
    if (result.fresh) {
      return {
        ...base,
        status: 'Pass',
        message: `Installation is fresh (${observedSummary}); binary, plugin, skill, schema, and cache match the recorded identity.`,
        durationMs: Date.now() - start,
      };
    }

    const dimensions = result.mismatches.map((m) => m.dimension).join(', ');
    return {
      ...base,
      status: 'Warning',
      message:
        `Installation is stale or mixed — mismatched dimension(s): ${dimensions}. ` +
        `Mutating workflow actions are BLOCKED until this is resolved.`,
      fix: result.mismatches.map((m) => `[${m.dimension}] ${m.remediation}`).join(' '),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'Warning',
      message: `Could not read the installed identity under ${posture.pluginRoot}: ${message}`,
      fix:
        `Verify the plugin install at ${posture.pluginRoot} is complete and readable, ` +
        `or reinstall via scripts/get-exarchos.{sh,ps1}.`,
      durationMs: Date.now() - start,
    };
  }
}
