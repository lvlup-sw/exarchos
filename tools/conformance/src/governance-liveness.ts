/**
 * Governance and packaging liveness — do the registers that govern this repo
 * still point at anything?
 *
 * Four registers decide who reviews a change and what ships:
 *
 *   `.github/CODEOWNERS`      who must review a path
 *   `package.json` `files[]`  what goes in the npm tarball
 *   `manifest.json`           what the plugin installer copies
 *   `protected-suites.json`   which suites may not be weakened
 *
 * All four FAIL OPEN. A CODEOWNERS pattern that matches nothing does not error;
 * ownership silently collapses to the `*` fallback and every review gate on
 * those paths disappears. A `files[]` entry naming a directory that no longer
 * exists does not error; npm just ships less. The failure is invisible in
 * exactly the way that matters — nothing turns red, and the register keeps
 * reading like it is doing its job.
 *
 * That is why this is a census over the LIVE tree rather than a schema check.
 * Every finding here is of one shape: a declared pattern with an empty match
 * set. The audit reports the count it matched alongside each verdict, so a
 * reader can tell "this pattern owns nothing" from "this census scanned
 * nothing" — the second failure mode being the one a liveness check is most
 * likely to die of.
 *
 * CODEOWNERS is extensionless, so any scan filtered by file extension cannot
 * see it. It is read by name.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './subject-root.js';

/** One declared pattern and how many tracked files it actually matches. */
export interface GovernanceSurface {
  /** Which register declared it. */
  readonly register: 'codeowners' | 'files' | 'manifest' | 'protected-suites';
  /** The pattern or path as written in the register. */
  readonly pattern: string;
  /** Tracked files it matches. Zero is the finding. */
  readonly matched: number;
  /**
   * A `files[]` entry naming a compile output (`dist/…`). These are not
   * tracked and are absent before `npm run build`; they are recorded so the
   * census can see them, but they are not `dead` on a clean checkout.
   */
  readonly buildOutput?: boolean;
}

export interface GovernanceLivenessResult {
  readonly ok: boolean;
  readonly surfaces: readonly GovernanceSurface[];
  /** Declared patterns matching nothing — the whole point of the census. */
  readonly dead: readonly GovernanceSurface[];
  /** Tracked files scanned. A zero here means the census itself is broken. */
  readonly trackedFiles: number;
}

/** Every tracked file, repo-relative and forward-slashed. */
export function trackedFiles(repoRoot: string = REPO_ROOT): string[] {
  return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => rel.length > 0);
}

/**
 * Parse CODEOWNERS into its patterns. Comments and blank lines are skipped; a
 * rule is `<pattern> <owner>…`, so the pattern is the first field.
 */
export function codeownersPatterns(repoRoot: string = REPO_ROOT): string[] {
  const file = path.join(repoRoot, '.github/CODEOWNERS');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((pattern) => pattern.length > 0);
}

/**
 * Does a CODEOWNERS pattern match a path? Supports the forms this repo uses —
 * `*` (everything), a `dir/` prefix, and a literal path. Deliberately not a
 * full gitignore engine: an unsupported form is reported as matching nothing
 * rather than assumed live, so the census fails toward reporting a hole.
 */
export function codeownersMatches(pattern: string, rel: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/')) return rel.startsWith(pattern);
  return rel === pattern || rel.startsWith(`${pattern}/`);
}

interface PackageManifest {
  readonly files?: readonly string[];
}

interface PluginComponent {
  readonly id?: string;
  readonly source?: string;
}

interface PluginManifest {
  readonly components?: Record<string, readonly PluginComponent[]>;
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Run the census.
 *
 * A `files[]` entry or a manifest `source` names a path rather than a glob, so
 * "matched" for those is the count of tracked files at or under it. Both are
 * counted the same way as a CODEOWNERS prefix so one reading of "dead" covers
 * every register.
 */
export function auditGovernanceLiveness(repoRoot: string = REPO_ROOT): GovernanceLivenessResult {
  const tracked = trackedFiles(repoRoot);
  const surfaces: GovernanceSurface[] = [];

  for (const pattern of codeownersPatterns(repoRoot)) {
    surfaces.push({
      register: 'codeowners',
      pattern,
      matched: tracked.filter((rel) => codeownersMatches(pattern, rel)).length,
    });
  }

  const pkg = readJson<PackageManifest>(path.join(repoRoot, 'package.json'));
  for (const entry of pkg?.files ?? []) {
    // A `files[]` entry may name a BUILD OUTPUT (`dist/…`) that is not tracked
    // and legitimately absent before a build. Count those by disk existence
    // and mark them `buildOutput` so a clean checkout does not report the
    // tarball dead. Source-tree entries are still counted from `git ls-files`.
    const buildOutput = entry.startsWith('dist/');
    const matched = buildOutput
      ? existsSync(path.join(repoRoot, entry))
        ? 1
        : 0
      : tracked.filter((rel) => rel === entry || rel.startsWith(`${entry}/`)).length;
    surfaces.push({ register: 'files', pattern: entry, matched, buildOutput });
  }

  const plugin = readJson<PluginManifest>(path.join(repoRoot, 'manifest.json'));
  for (const [, components] of Object.entries(plugin?.components ?? {})) {
    for (const component of components) {
      const source = component.source;
      if (source === undefined) continue;
      surfaces.push({
        register: 'manifest',
        pattern: source,
        matched: tracked.filter((rel) => rel === source || rel.startsWith(`${source}/`)).length,
      });
    }
  }

  const dead = surfaces.filter((s) => s.matched === 0 && s.buildOutput !== true);
  return { ok: dead.length === 0, surfaces, dead, trackedFiles: tracked.length };
}

/** Render the census for a failing assertion. */
export function formatGovernanceLiveness(result: GovernanceLivenessResult): string {
  if (result.ok) return `governance liveness OK (${result.surfaces.length} surfaces)`;
  return [
    `${result.dead.length} declared governance surface(s) match nothing:`,
    ...result.dead.map((s) => `  ${s.register}: ${s.pattern}`),
    '',
    'A register entry that matches nothing fails OPEN — ownership falls through to',
    'the default, or the packaged set silently shrinks. Repoint it or delete it.',
  ].join('\n');
}
