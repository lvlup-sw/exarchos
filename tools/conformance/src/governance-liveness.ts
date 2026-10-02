/**
 * A liveness census of the registers that govern this repo. Each register decides
 * who reviews a change or what ships:
 *
 * - `.github/CODEOWNERS`: who must review a path.
 * - `package.json` `files[]`: what goes in the npm tarball.
 * - `manifest.json`: what the plugin installer copies.
 * - `protected-suites.json`: which suites a change must not weaken.
 *
 * All four fail open. A pattern that matches nothing raises no error, so review
 * ownership or the shipped set shrinks silently. Each finding is a declared pattern
 * with an empty match set. The result also reports the tracked-file count, so a
 * reader can tell an empty pattern from an empty scan.
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
   * True for a `files[]` entry that names a compile output (`dist/…`). Git does not
   * track these, and they are absent before `npm run build`. The census records them
   * but does not report them as dead.
   */
  readonly buildOutput?: boolean;
}

export interface GovernanceLivenessResult {
  readonly ok: boolean;
  readonly surfaces: readonly GovernanceSurface[];
  /** Declared patterns that match nothing. */
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
 * Parses CODEOWNERS into its patterns. It skips comments and blank lines. The
 * pattern is the first field of a `<pattern> <owner>…` rule.
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

import { codeownersMatches as matchCodeownersPattern } from '../../../tools/audit/lib/codeowners-match.mjs';

/**
 * Tells if a CODEOWNERS pattern matches a path. It supports `*`, a `dir/` prefix and
 * a literal path. An unsupported form matches nothing, so the census reports a hole
 * and does not assume the pattern is live.
 */
export const codeownersMatches: (pattern: string, rel: string) => boolean = matchCodeownersPattern;

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
 * Runs the census. A `files[]` entry or a manifest `source` names a path, not a glob.
 * Its match count is the number of tracked files at or under that path, as for a
 * CODEOWNERS prefix.
 *
 * A `files[]` entry under `dist/` names a build output that git does not track. The
 * census counts it by disk existence and marks it `buildOutput`, so a clean checkout
 * does not report the tarball as dead.
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

  const protectedSuites = readJson<{
    readonly files?: readonly string[];
    readonly generatedFrom?: string;
  }>(path.join(repoRoot, 'tools/audit/protected-suites.json'));
  const generatedFrom = protectedSuites?.generatedFrom ?? '';
  for (const rel of protectedSuites?.files ?? []) {
    const resolved = existsSync(path.join(repoRoot, rel))
      ? rel
      : path.posix.join(generatedFrom, rel);
    surfaces.push({
      register: 'protected-suites',
      pattern: rel,
      matched: tracked.filter((t) => t === rel || t === resolved).length,
    });
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
