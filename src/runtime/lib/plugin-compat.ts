/**
 * Plugin-root compatibility check. Its one caller is
 * `exarchos version --check-plugin-root <path>`, a CI diagnostic that exits 1
 * on drift. This module holds the policy and does not print. The caller sets
 * the exit code and the output from the returned `CompatResult`.
 *
 * Drift means that the declared `metadata.compat.minBinaryVersion` is greater
 * than the binary version. A missing `plugin.json`, invalid JSON, or no valid
 * minimum gives an advisory: `compatible: true` and `minRequired: null`.
 *
 * The module has no runtime dependencies and reads `plugin.json`
 * synchronously, so the CLI subcommand starts fast.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Result of {@link checkPluginRootCompatibility}:
 * - `compatible: true, minRequired: null`: an advisory, not a failure.
 * - `compatible: true, minRequired: "<ver>"`: the binary satisfies the minimum.
 * - `compatible: false`: the declared minimum is newer than the binary, and
 *   `message` names both versions.
 */
export interface CompatResult {
  readonly compatible: boolean;
  readonly minRequired: string | null;
  readonly actual: string;
  readonly message: string;
}

/**
 * Compare two semver strings. The result is negative when `a < b`, 0 when they
 * are equal, and positive when `a > b`. A leading `v` is removed, a missing
 * minor or patch segment is 0, and build metadata is ignored. A version with a
 * prerelease tag is less than the same version without one. Prerelease fields
 * compare one by one: numbers numerically, other fields lexically, and a
 * number is less than a non-number. A non-numeric core segment counts as 0.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);

  for (let i = 0; i < 3; i++) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) {
      return l - r;
    }
  }

  const aHasPre = left.prerelease.length > 0;
  const bHasPre = right.prerelease.length > 0;
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  if (!aHasPre && !bHasPre) return 0;

  const len = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = left.prerelease[i] ?? '';
    const bi = right.prerelease[i] ?? '';
    const aNum = /^[0-9]+$/.test(ai);
    const bNum = /^[0-9]+$/.test(bi);

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

  return left.prerelease.length - right.prerelease.length;
}

interface ParsedSemver {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

/**
 * Parse a semver-like string into a core tuple and prerelease fields, as
 * {@link compareSemver} describes.
 */
function parseSemver(raw: string): ParsedSemver {
  const noBuild = raw.replace(/^v/, '').split('+')[0] ?? '';
  const [coreStrRaw, ...preParts] = noBuild.split('-');
  const coreStr = coreStrRaw ?? '';
  const prerelease = preParts.length > 0 ? preParts.join('-').split('.') : [];

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

/**
 * Check that the binary satisfies the `metadata.compat.minBinaryVersion` of the
 * plugin root. Callers act on the returned `CompatResult`:
 * - An absent `plugin.json`, invalid JSON, or no valid minimum is an advisory.
 * - A binary at or above the minimum is compatible.
 * - A binary below the minimum is drift, and `version --check-plugin-root`
 *   exits 1.
 *
 * @param pluginRoot Absolute path of the directory that holds `.claude-plugin/plugin.json`.
 * @param binaryVersion Semver of the running binary, typically `SERVER_VERSION`.
 */
export function checkPluginRootCompatibility(
  pluginRoot: string,
  binaryVersion: string,
): CompatResult {
  const pluginJsonPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');

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

  const minRequired = extractMinBinaryVersion(parsed);
  if (minRequired === null) {
    return {
      compatible: true,
      minRequired: null,
      actual: binaryVersion,
      message: 'plugin.json has no metadata.compat.minBinaryVersion',
    };
  }

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
 * Loose semver gate: a core of `X`, `X.Y` or `X.Y.Z`, an optional leading `v`,
 * and optional `-prerelease` and `+build` suffixes. Thus a plugin can pin only
 * a major or a major.minor. The gate rejects values such as `banana` and `2.x`.
 */
const SEMVER_LIKE = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Return `metadata.compat.minBinaryVersion` from a parsed `plugin.json`. Return
 * `null` when the path is absent, the value is empty, or the value is not
 * semver-like. Without this check, `parseSemver` turns bad segments into 0, and
 * a malformed pin passes the drift check.
 */
function extractMinBinaryVersion(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const compat = (metadata as Record<string, unknown>).compat;
  if (!compat || typeof compat !== 'object') return null;
  const min = (compat as Record<string, unknown>).minBinaryVersion;
  if (typeof min !== 'string') return null;
  const normalized = min.trim();
  if (normalized.length === 0) return null;
  if (!SEMVER_LIKE.test(normalized)) return null;
  return normalized;
}
