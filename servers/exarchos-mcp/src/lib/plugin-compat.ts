// ─── Plugin-Root Compatibility Library ─────────────────────────────────────
//
// Shared across two call sites:
//   1. `exarchos version --check-plugin-root <path>` — standalone CI diagnostic.
//   2. `handleSessionStart()` — per-session drift warning (non-blocking).
//
// Both call sites share this module so the compat policy (what counts as
// incompatible vs. non-fatal warning vs. error) has exactly one source of
// truth. Callers decide exit code and stderr/stdout formatting from the
// returned `CompatResult`; this module does not print.
//
// Non-fatal policy (returns `compatible: true, minRequired: null`):
//   - plugin root directory does not exist
//   - `.claude-plugin/plugin.json` is missing or unreadable
//   - `plugin.json` is not valid JSON
//   - `metadata.compat.minBinaryVersion` is absent or not a string
//
// Fatal drift (returns `compatible: false`):
//   - declared `minBinaryVersion` is strictly greater than the running
//     binary's version, per semver precedence.
//
// The module has ZERO runtime dependencies — reads `plugin.json`
// synchronously via `fs.readFileSync` so both the CLI subcommand and the
// session-start handler can call it without blowing the 250ms cold-start
// budget. Synchronous I/O is safe here: the file is small (< 4KB) and sits
// in the plugin root, which is always local disk.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Result returned by {@link checkPluginRootCompatibility}.
 *
 * - `compatible: true, minRequired: null` — non-fatal warning (missing
 *   plugin.json, missing compat metadata). Callers should typically treat
 *   this as a soft advisory, not a hard failure.
 * - `compatible: true, minRequired: "<ver>"` — plugin declares a min
 *   version and the running binary satisfies it.
 * - `compatible: false` — declared `minBinaryVersion` is newer than the
 *   running binary. The `message` field names both versions for stderr.
 */
export interface CompatResult {
  readonly compatible: boolean;
  readonly minRequired: string | null;
  readonly actual: string;
  readonly message: string;
}

// ─── Semver Comparison ──────────────────────────────────────────────────────

/**
 * Compare two semver strings.
 *
 * Returns:
 *   - negative if `a < b`
 *   - 0       if `a === b`
 *   - positive if `a > b`
 *
 * Normalizations applied to both inputs:
 *   - leading `v` prefix stripped (`"v2.9.0"` → `"2.9.0"`)
 *   - missing minor/patch segments default to `0` (`"2.9"` → `"2.9.0"`)
 *
 * Prerelease handling follows semver §11 precedence:
 *   - a version with a prerelease tag (`2.9.0-beta.1`) compares LESS than
 *     the same version without one (`2.9.0`).
 *   - prerelease identifiers are compared field-by-field. Numeric
 *     identifiers compare numerically; alphanumeric compare
 *     lexicographically. Numeric identifiers have lower precedence than
 *     alphanumeric ones of the same position.
 *
 * Build metadata (`+build.123`) is ignored per semver §10.
 *
 * Inputs that are not parseable as semver (e.g. `""` or `"not-a-version"`)
 * yield a best-effort comparison: after `v`-prefix strip and segment
 * normalization they are treated as `NaN` components, which compare equal
 * to each other and less than any numeric component. This library is not
 * a general-purpose semver parser; it is scoped to compare Exarchos binary
 * and plugin versions, which are controlled by our own release process.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);

  // Compare major/minor/patch in order.
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) {
      return left.core[i] - right.core[i];
    }
  }

  // Semver §11: a version with a prerelease tag is LESS than the same
  // release without one. If only one side has a prerelease, that side
  // is smaller.
  const aHasPre = left.prerelease.length > 0;
  const bHasPre = right.prerelease.length > 0;
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  if (!aHasPre && !bHasPre) return 0;

  // Both have prerelease — compare identifier-by-identifier.
  const len = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = left.prerelease[i];
    const bi = right.prerelease[i];
    const aNum = /^[0-9]+$/.test(ai);
    const bNum = /^[0-9]+$/.test(bi);

    // Numeric identifiers have lower precedence than alphanumeric.
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;

    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }

  // Shorter prerelease list has lower precedence (semver §11).
  return left.prerelease.length - right.prerelease.length;
}

interface ParsedSemver {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

/**
 * Parse a semver-ish string into normalized components. Not exported —
 * callers should use {@link compareSemver}. See {@link compareSemver} for
 * the tolerated input forms.
 */
function parseSemver(raw: string): ParsedSemver {
  // Strip leading `v` and build metadata (`+...`).
  const noBuild = raw.replace(/^v/, '').split('+')[0];
  const [coreStr, ...preParts] = noBuild.split('-');
  const prerelease = preParts.length > 0 ? preParts.join('-').split('.') : [];

  // Pad missing segments with 0. `parseInt` with a non-numeric segment
  // yields NaN; we normalize NaN to 0 so invalid tails compare equal
  // rather than throwing. (Real Exarchos releases always include all
  // three segments; this is defensive.)
  const segments = coreStr.split('.');
  const major = toInt(segments[0]);
  const minor = toInt(segments[1]);
  const patch = toInt(segments[2]);

  return {
    core: [major, minor, patch],
    prerelease,
  };
}

function toInt(s: string | undefined): number {
  if (s === undefined || s === '') return 0;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// ─── Plugin Compat Check ────────────────────────────────────────────────────

/**
 * Check whether a plugin root's declared `metadata.compat.minBinaryVersion`
 * is satisfied by the running binary.
 *
 * See the module-level comment for the non-fatal-vs-fatal policy. Callers
 * are expected to:
 *   - render `message` to stderr in CLI contexts;
 *   - gate exit code on `compatible` when they care about blocking (the
 *     `version --check-plugin-root` subcommand maps `compatible: false`
 *     to exit 1 so CI catches drift);
 *   - treat `minRequired: null` as an advisory, not a failure.
 *
 * @param pluginRoot absolute path to a plugin root directory (the one
 *                   containing `.claude-plugin/plugin.json`).
 * @param binaryVersion the running binary's semver, typically
 *                      `SERVER_VERSION` from `src/index.ts`.
 */
export function checkPluginRootCompatibility(
  pluginRoot: string,
  binaryVersion: string,
): CompatResult {
  const pluginJsonPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');

  // Step 1 — read + parse plugin.json.
  let raw: string;
  try {
    raw = fs.readFileSync(pluginJsonPath, 'utf-8');
  } catch {
    return {
      compatible: true,
      minRequired: null,
      actual: binaryVersion,
      message: `plugin root has no plugin.json at ${pluginJsonPath}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      compatible: true,
      minRequired: null,
      actual: binaryVersion,
      message: `plugin.json at ${pluginJsonPath} is not valid JSON`,
    };
  }

  // Step 2 — navigate to metadata.compat.minBinaryVersion safely.
  const minRequired = extractMinBinaryVersion(parsed);
  if (minRequired === null) {
    return {
      compatible: true,
      minRequired: null,
      actual: binaryVersion,
      message: 'plugin.json has no metadata.compat.minBinaryVersion',
    };
  }

  // Step 3 — compare via shared semver helper.
  const cmp = compareSemver(binaryVersion, minRequired);
  if (cmp >= 0) {
    return {
      compatible: true,
      minRequired,
      actual: binaryVersion,
      message: `binary ${binaryVersion} satisfies plugin minBinaryVersion ${minRequired}`,
    };
  }

  return {
    compatible: false,
    minRequired,
    actual: binaryVersion,
    message:
      `binary ${binaryVersion} is older than plugin minBinaryVersion ${minRequired} — ` +
      `upgrade the Exarchos binary or pin to a plugin version that supports ${binaryVersion}`,
  };
}

/**
 * Extract `metadata.compat.minBinaryVersion` from a parsed plugin.json
 * without any assumption that intermediate keys exist. Returns null when
 * the path is absent OR the leaf is not a non-empty string.
 */
function extractMinBinaryVersion(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const compat = (metadata as Record<string, unknown>).compat;
  if (!compat || typeof compat !== 'object') return null;
  const min = (compat as Record<string, unknown>).minBinaryVersion;
  if (typeof min !== 'string' || min.length === 0) return null;
  return min;
}
