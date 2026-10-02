/** Prerequisite checks for the Exarchos installer: the JavaScript runtime, tool versions, and the full prerequisite list. */

import { execSync } from 'node:child_process';

/**
 * Detect the JavaScript runtime for the MCP server. Node comes first, and bun is the fallback.
 * The server bundle targets Node and needs Node-native modules such as better-sqlite3. Bun is only a build tool.
 *
 * @returns The detected runtime identifier.
 * @throws If neither node nor bun is available.
 */
export function detectRuntime(): 'node' | 'bun' {
  try {
    execSync('node --version', { stdio: 'pipe' });
    return 'node';
  } catch {
  }

  try {
    execSync('bun --version', { stdio: 'pipe' });
    return 'bun';
  } catch {
  }

  throw new Error(
    'No JavaScript runtime found. Install Node.js >= 20 (https://nodejs.org) or bun (https://bun.sh).',
  );
}

/**
 * Get the `major.minor.patch` version of a command. The function strips a leading `v`, as in the node output `v20.11.0`.
 *
 * @param command - The command to run, for example 'bun' or 'node'.
 * @param args - Arguments to pass, for example ['--version'].
 * @returns The parsed version string, or null if the command fails or output is invalid.
 */
export function getVersion(command: string, args: string[]): string | null {
  try {
    const output = execSync(`${command} ${args.join(' ')}`, { stdio: 'pipe' });
    const trimmed = output.toString().trim();

    const cleaned = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;

    if (/^\d+\.\d+\.\d+/.test(cleaned)) {
      const match = cleaned.match(/^(\d+\.\d+\.\d+)/);
      return match?.[1] ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether an actual version meets a minimum version, with a numeric comparison of `major.minor.patch`.
 *
 * @param actual - The actual version string, for example "1.3.4".
 * @param minimum - The minimum required version, for example "1.0.0".
 * @returns True if actual >= minimum.
 */
export function meetsMinVersion(actual: string, minimum: string): boolean {
  const parseParts = (v: string): [number, number, number] => {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const [aMajor, aMinor, aPatch] = parseParts(actual);
  const [mMajor, mMinor, mPatch] = parseParts(minimum);

  if (aMajor !== mMajor) return aMajor > mMajor;
  if (aMinor !== mMinor) return aMinor > mMinor;
  return aPatch >= mPatch;
}

/** Definition of a single prerequisite tool. */
export interface Prerequisite {
  /** The command to check, for example 'bun'. */
  readonly command: string;
  /** Arguments to get the version, for example ['--version']. */
  readonly args: string[];
  /** Whether this prerequisite is required for installation to proceed. */
  readonly required: boolean;
  /** Minimum acceptable version (optional). */
  readonly minVersion?: string;
  /** Human-readable hint on how to install this tool. */
  readonly installHint: string;
}

/** Result of checking a single prerequisite. */
export interface PrerequisiteResult {
  /** The command that was checked. */
  readonly command: string;
  /** Whether the command was found on the system. */
  readonly found: boolean;
  /** The detected version, if any. */
  readonly version?: string;
  /** Whether the detected version meets the minimum requirement. */
  readonly meetsMinVersion: boolean;
  /** Human-readable hint on how to install this tool. */
  readonly installHint: string;
}

/**
 * Check a single prerequisite tool: its version, and the minimum version when one is set.
 *
 * @param prereq - The prerequisite definition to check.
 * @returns The check result.
 */
export function checkPrerequisite(prereq: Prerequisite): PrerequisiteResult {
  const version = getVersion(prereq.command, prereq.args);

  if (version === null) {
    return {
      command: prereq.command,
      found: false,
      meetsMinVersion: false,
      installHint: prereq.installHint,
    };
  }

  const versionOk = prereq.minVersion
    ? meetsMinVersion(version, prereq.minVersion)
    : true;

  return {
    command: prereq.command,
    found: true,
    version,
    meetsMinVersion: versionOk,
    installHint: prereq.installHint,
  };
}

/** Aggregated report from checking all prerequisites. */
export interface PrerequisiteReport {
  /** Individual results for each prerequisite. */
  readonly results: PrerequisiteResult[];
  /** Whether installation can proceed (all required prerequisites satisfied). */
  readonly canProceed: boolean;
  /** Human-readable messages for each blocking issue. */
  readonly blockers: string[];
}

/**
 * Check all prerequisites and produce an aggregated report.
 *
 * @param prereqs - The list of prerequisites to check.
 * @returns A report indicating whether installation can proceed.
 */
export function checkAllPrerequisites(prereqs: Prerequisite[]): PrerequisiteReport {
  const checks = prereqs.map((prereq) => ({
    prereq,
    result: checkPrerequisite(prereq),
  }));
  const results = checks.map((c) => c.result);
  const blockers: string[] = [];

  for (const { prereq, result } of checks) {
    if (!prereq.required) continue;

    if (!result.found) {
      blockers.push(
        `Required tool '${prereq.command}' not found. Install: ${prereq.installHint}`,
      );
    } else if (!result.meetsMinVersion && prereq.minVersion) {
      blockers.push(
        `Required tool '${prereq.command}' version ${result.version} is below minimum ${prereq.minVersion}. Update: ${prereq.installHint}`,
      );
    }
  }

  return {
    results,
    canProceed: blockers.length === 0,
    blockers,
  };
}

/** Default prerequisites for the Exarchos installer. */
export const DEFAULT_PREREQUISITES: readonly Prerequisite[] = [
  {
    command: 'node',
    args: ['--version'],
    required: true,
    minVersion: '20.0.0',
    installHint: 'Install via nvm or nodejs.org',
  },
  {
    command: 'bun',
    args: ['--version'],
    required: true,
    minVersion: '1.0.0',
    installHint: 'Build tool. Install: curl -fsSL https://bun.sh/install | bash',
  },
];
