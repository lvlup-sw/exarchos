/**
 * freshness-check — the pre-workflow-execution gate that blocks a stale or
 * mixed Exarchos installation before any workflow runs (P05-04; ART-006,
 * ART-007, ART-009, ART-013).
 *
 * It compares an `expected` identity (what the running binary requires — its
 * own version/digest and the artifacts it ships) against an `observed` identity
 * (what is actually installed at the runtime locations: the plugin manifest on
 * disk, the rendered skills, the event store's schema version, the cache).
 * Divergence on any of the five dimensions produces a typed, actionable block.
 *
 * The failure this prevents: a user upgrades the binary but keeps a stale
 * plugin / skill / cache directory, or an event store written under a newer
 * schema is opened by an older binary. Today that silently half-works; here it
 * blocks with an {@link InstallFreshnessError} naming exactly which dimension
 * mismatched and what to do about it.
 *
 * Directional policy per dimension:
 *   - binary / plugin / skill / cache — ANY difference between expected and
 *     observed is stale and blocks (these are the artifacts the binary ships,
 *     so they must match exactly).
 *   - schema — asymmetric, mirroring the forward-only migration machinery: an
 *     OLDER store (observed < expected) is forward-migrated on open and does
 *     NOT block here; only a NEWER store (observed > expected) blocks, because
 *     an older binary must not open a store written by a newer one (the store's
 *     own open path enforces the same rule via `SchemaVersionTooNewError`).
 */

import type { InstallIdentity } from './install-identity.js';

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
 * The sentinel substituted when the binary version cannot be read off the
 * install's `package.json`. It is a placeholder for an ABSENT observation, not
 * a version — so it must never satisfy an equality comparison against another
 * copy of itself.
 */
export const UNKNOWN_VERSION_SENTINEL = '0.0.0-unknown';

/**
 * Result of a freshness verification.
 *
 * `indeterminate` is the third state, and its absence was a defect: the binary
 * version falls back to {@link UNKNOWN_VERSION_SENTINEL} when it cannot be
 * read, and comparing two unknowns by equality reported the dimension as
 * MATCHING. `doctor` then printed "binary, plugin, skill, schema, and cache
 * match the recorded identity" while separately warning it could not determine
 * the running plugin version — an absent observation converted into positive
 * assurance.
 *
 * An undetermined dimension now yields `indeterminate`, which callers surface
 * as a non-assertion. It is deliberately NOT a mismatch: blocking on an
 * unreadable `package.json` would turn the freshness gate into a new outage
 * class, which this module's robustness policy exists to prevent. The trade is
 * a false pass for an honest "cannot tell", not for a block.
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
 * Thrown by {@link assertInstallFreshness} when one or more install dimensions
 * are stale/mixed. Carries the structured `mismatches` so a caller can render
 * per-dimension remediation rather than parsing a string. Terminates before
 * workflow execution — consumers must not catch it and continue.
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
 * Compare an `expected` identity against an `observed` identity across all five
 * dimensions and report every mismatch (never short-circuits — a caller sees
 * the full stale/mixed picture, not just the first failure).
 */
export function verifyInstallFreshness(
  expected: InstallIdentity,
  observed: InstallIdentity,
): FreshnessResult {
  const mismatches: FreshnessMismatch[] = [];

  // Indeterminate dimensions are settled BEFORE any equality comparison, so an
  // unknown can never be folded into a pass by matching another unknown.
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

  // binary — exact match on version AND artifact digest.
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

  // plugin — exact match on manifest digest.
  if (expected.plugin.manifestDigest !== observed.plugin.manifestDigest) {
    mismatches.push({
      dimension: 'plugin',
      expected: expected.plugin.manifestDigest,
      observed: observed.plugin.manifestDigest,
      remediation: REMEDIATION.plugin,
    });
  }

  // skill — exact match on rendered-tree digest.
  if (expected.skill.digest !== observed.skill.digest) {
    mismatches.push({
      dimension: 'skill',
      expected: expected.skill.digest,
      observed: observed.skill.digest,
      remediation: REMEDIATION.skill,
    });
  }

  // schema — directional. Only a store NEWER than the binary blocks; older
  // stores are forward-migrated on open, equal stores match.
  if (observed.schema.version > expected.schema.version) {
    mismatches.push({
      dimension: 'schema',
      expected: `<= schema v${expected.schema.version}`,
      observed: `schema v${observed.schema.version}`,
      remediation: REMEDIATION.schema,
    });
  }

  // cache — exact match on location AND content digest.
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
 * The blocking gate: verify freshness and THROW {@link InstallFreshnessError}
 * on any mismatch. This is the primitive to call before workflow execution;
 * on a matching installation it returns normally (the store's own open path
 * additionally enforces the schema dimension via `SchemaVersionTooNewError`).
 */
export function assertInstallFreshness(
  expected: InstallIdentity,
  observed: InstallIdentity,
): void {
  const result = verifyInstallFreshness(expected, observed);
  if (result.fresh) return;
  // An undetermined dimension is not a confirmed mismatch — only a CONFIRMED
  // mismatch blocks. See the `indeterminate` note on FreshnessResult.
  if ('indeterminate' in result) return;
  throw new InstallFreshnessError(result.mismatches);
}
