/**
 * Freshness gate. It blocks a stale or mixed Exarchos installation before a workflow runs.
 *
 * It compares an `expected` identity (what the running binary requires) with an
 * `observed` identity (what is installed: plugin manifest, rendered skills,
 * event store schema version, cache). A difference gives a typed block that names the dimension.
 *
 * Policy for each dimension:
 *   - binary, plugin, skill, cache: any difference is stale and blocks.
 *   - schema: only a store newer than the binary blocks. An older store migrates
 *     forward on open. The store open path enforces the same rule with `SchemaVersionTooNewError`.
 */

import { UNKNOWN_VERSION_SENTINEL, type InstallIdentity } from './install-identity.js';

/** The five independently-seedable, independently-blocking mismatch dimensions. */
export type FreshnessDimension = 'binary' | 'plugin' | 'skill' | 'schema' | 'cache';

/** Stable evaluation order — mismatches are always reported in this order. */
export const FRESHNESS_DIMENSIONS: readonly FreshnessDimension[] = [
  'binary',
  'plugin',
  'skill',
  'schema',
  'cache',
] as const;

/** One dimension that diverged, with a human-actionable remediation. */
export interface FreshnessMismatch {
  readonly dimension: FreshnessDimension;
  readonly expected: string;
  readonly observed: string;
  readonly remediation: string;
}

/**
 * Result of a freshness verification. It has three states: fresh, mismatched, and `indeterminate`.
 *
 * The binary version falls back to {@link UNKNOWN_VERSION_SENTINEL} when it cannot be read.
 * Two unknown values must not count as a match, so an unreadable dimension gives `indeterminate`.
 * Callers show it as "cannot tell". It is not a mismatch, because a block on an
 * unreadable `package.json` makes the gate a new cause of outage.
 */
export type FreshnessResult =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly indeterminate: true; readonly dimensions: readonly FreshnessDimension[]; readonly reason: string }
  | { readonly fresh: false; readonly mismatches: readonly FreshnessMismatch[] };

/** True when a recorded/observed version pair cannot support a match verdict. */
function isIndeterminateVersion(value: string): boolean {
  return value === UNKNOWN_VERSION_SENTINEL || value.trim() === '';
}

/**
 * Thrown by {@link assertInstallFreshness} when one or more dimensions are stale.
 * It carries the structured `mismatches`, so a caller can show the remediation for each dimension.
 * A caller must not catch it and continue the workflow.
 */
export class InstallFreshnessError extends Error {
  override readonly name = 'InstallFreshnessError';
  readonly code = 'INSTALL_FRESHNESS_MISMATCH';
  constructor(public readonly mismatches: readonly FreshnessMismatch[]) {
    super(
      `Installation is stale or mixed — blocking before workflow execution. ` +
        `${mismatches.length} dimension(s) mismatched:\n` +
        mismatches
          .map(
            (m) =>
              `  • ${m.dimension}: expected ${m.expected}, observed ${m.observed}. ${m.remediation}`,
          )
          .join('\n'),
    );
  }
}

const REMEDIATION: Record<FreshnessDimension, string> = {
  binary:
    'Reinstall the exarchos binary (scripts/get-exarchos.{sh,ps1}) so the running version and ' +
    'its distributed artifact match the recorded install identity.',
  plugin:
    'Reinstall the exarchos plugin so its manifest matches the running binary ' +
    '(the plugin cache is stale relative to the upgraded binary).',
  skill:
    'Re-render the skills (npm run build:skills) so the installed skill tree matches the ' +
    'running binary; the skills/<runtime> output is stale.',
  schema:
    'Upgrade the exarchos binary to a release that understands the store schema, or point ' +
    'WORKFLOW_STATE_DIR at a store written by this binary — a newer store must not be opened ' +
    'by an older binary (downgrade is unsupported).',
  cache:
    'Clear the exarchos cache directory so it is rebuilt by the running binary; the cached ' +
    'content is stale relative to the upgraded install.',
};

function binaryFingerprint(id: InstallIdentity): string {
  return `${id.binary.version}@${id.binary.digest}`;
}

/**
 * Compare an `expected` identity with an `observed` identity.
 * If a binary version is unreadable, the result is `indeterminate` before any comparison.
 * This stops two unknown values from counting as a match.
 * If not, the function reports each mismatched dimension, not only the first.
 */
export function verifyInstallFreshness(
  expected: InstallIdentity,
  observed: InstallIdentity,
): FreshnessResult {
  const mismatches: FreshnessMismatch[] = [];

  const undetermined: FreshnessDimension[] = [];
  if (isIndeterminateVersion(expected.binary.version) || isIndeterminateVersion(observed.binary.version)) {
    undetermined.push('binary');
  }
  if (undetermined.length > 0) {
    return {
      fresh: false,
      indeterminate: true,
      dimensions: undetermined,
      reason:
        `Undetermined dimension(s): ${undetermined.join(', ')} — the version could not be read, ` +
        `so freshness cannot be asserted either way. An unreadable install is reported as ` +
        `unknown rather than counted as a match.`,
    };
  }

  if (
    expected.binary.version !== observed.binary.version ||
    expected.binary.digest !== observed.binary.digest
  ) {
    mismatches.push({
      dimension: 'binary',
      expected: binaryFingerprint(expected),
      observed: binaryFingerprint(observed),
      remediation: REMEDIATION.binary,
    });
  }

  if (expected.plugin.manifestDigest !== observed.plugin.manifestDigest) {
    mismatches.push({
      dimension: 'plugin',
      expected: expected.plugin.manifestDigest,
      observed: observed.plugin.manifestDigest,
      remediation: REMEDIATION.plugin,
    });
  }

  if (expected.skill.digest !== observed.skill.digest) {
    mismatches.push({
      dimension: 'skill',
      expected: expected.skill.digest,
      observed: observed.skill.digest,
      remediation: REMEDIATION.skill,
    });
  }

  if (observed.schema.version > expected.schema.version) {
    mismatches.push({
      dimension: 'schema',
      expected: `<= schema v${expected.schema.version}`,
      observed: `schema v${observed.schema.version}`,
      remediation: REMEDIATION.schema,
    });
  }

  if (
    expected.cache.location !== observed.cache.location ||
    expected.cache.digest !== observed.cache.digest
  ) {
    mismatches.push({
      dimension: 'cache',
      expected: `${expected.cache.location}#${expected.cache.digest}`,
      observed: `${observed.cache.location}#${observed.cache.digest}`,
      remediation: REMEDIATION.cache,
    });
  }

  return mismatches.length === 0 ? { fresh: true } : { fresh: false, mismatches };
}

/**
 * The blocking gate. Call it before workflow execution. It throws
 * {@link InstallFreshnessError} on a confirmed mismatch.
 * It returns normally when the result is fresh or `indeterminate`.
 */
export function assertInstallFreshness(
  expected: InstallIdentity,
  observed: InstallIdentity,
): void {
  const result = verifyInstallFreshness(expected, observed);
  if (result.fresh) return;
  if ('indeterminate' in result) return;
  throw new InstallFreshnessError(result.mismatches);
}
