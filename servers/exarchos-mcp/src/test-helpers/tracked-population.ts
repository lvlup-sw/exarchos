import { execFileSync } from 'node:child_process';

/**
 * DR-8 — the SECOND AUTHORITY for a guard's denominator.
 *
 * A structural guard walks a tree and asserts something about what it found.
 * That assertion is only worth as much as the walk: a scan that lost 96% of the
 * tree, or was pointed at a subtree that moved, still reports "no violations".
 * The tooth that catches it has to know how big the tree really is — and it must
 * learn that from somewhere the walk cannot influence.
 *
 * `git ls-files` is that somewhere. It knows nothing about a scanner's recursion,
 * its exclusion set, or its extension filter; it reports what the repository
 * TRACKS. So when a guard's walk and this list agree, the agreement is evidence
 * the walk reached the tree. When they disagree, the disagreement names the
 * modules that went missing.
 *
 * This exists once, here, because a per-test copy of the same `execFileSync('git',
 * ['ls-files', …])` incantation is exactly the multiply-owned representation the
 * programme is closing: five copies drift, and the drift is invisible precisely
 * where the guard is meant to be loud.
 *
 * Two shapes are exported deliberately:
 *   • {@link listTrackedFiles} — the paths, so a shortfall can NAME what the walk
 *     missed rather than reporting a smaller integer;
 *   • {@link countTrackedFiles} — the count, for the band-style pins.
 *
 * Prefer the list. `expect(missed).toEqual([])` fails with the offending module
 * names; `expect(n).toBeGreaterThan(m)` fails with two numbers.
 *
 * TRACKED, not present: git reports what is committed or staged, so a brand-new
 * untracked module is invisible here. That is the safe direction for a
 * denominator — the assertion built on it is `tracked ⊆ walked`, so an untracked
 * scratch file makes the walk larger, never the authority smaller, and cannot
 * turn a real shortfall green.
 */

/**
 * Path segments excluded BY PROPERTY, never by naming a subtree (DR-8):
 * dependency trees and build output are not first-party source, and no guard in
 * this repository governs them. Dot-directories are excluded by the same rule —
 * `.claude/worktrees/` holds complete sibling checkouts of this repository, so a
 * repo-root walk that recursed into them would count every module several times
 * over, with the multiple depending on how many agents happened to be running.
 */
const EXCLUDED_BY_PROPERTY = (segment: string): boolean =>
  segment === 'node_modules' || segment === 'dist' || segment.startsWith('.');

export interface TrackedPopulationQuery {
  /** File extensions that constitute the population. Default: `['.ts']`. */
  readonly extensions?: readonly string[];
  /**
   * Additional rejection predicate over the `root`-relative, forward-slashed
   * path — used to mirror a scanner's own exclusions (its harness directories,
   * its `*.test.ts` filter) so the two sides describe the same population and a
   * shortfall means a broken walk rather than a definitional mismatch.
   */
  readonly exclude?: (relativePath: string) => boolean;
}

/**
 * Every file `root` tracks, `root`-relative and forward-slashed, sorted.
 *
 * Throws when the query resolves nothing: a second authority that answers zero
 * cannot corroborate anything, and a silent empty list would make every
 * containment assertion built on it vacuously true — the very failure mode this
 * module exists to detect, reproduced inside the detector.
 */
export function listTrackedFiles(root: string, query: TrackedPopulationQuery = {}): string[] {
  const extensions = query.extensions ?? ['.ts'];
  const pathspecs = extensions.map((extension) => `*${extension}`);
  const stdout = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const files = stdout
    .split('\0')
    .filter((line) => line.length > 0)
    .filter((line) => !line.split('/').some(EXCLUDED_BY_PROPERTY))
    .filter((line) => query.exclude === undefined || !query.exclude(line))
    .sort();

  if (files.length === 0) {
    throw new Error(
      `tracked-population: \`git ls-files\` resolved no ${extensions.join('/')} file under ` +
        `${root}. The second authority is empty, so it can corroborate nothing — the root ` +
        'moved, the extensions are wrong, or this is not a git worktree.',
    );
  }
  return files;
}

/** How many files `root` tracks under {@link listTrackedFiles}'s query. */
export function countTrackedFiles(root: string, query: TrackedPopulationQuery = {}): number {
  return listTrackedFiles(root, query).length;
}

/**
 * The tracked files a walk did NOT reach, capped for a legible failure message.
 *
 * The asymmetry is deliberate: EXTRA modules in the walk are benign (an untracked
 * scratch file in a working tree), while MISSING ones mean the walk did not cover
 * the population the guard claims to govern. Only the second direction is a
 * finding.
 */
export function trackedFilesMissedBy(
  walked: Iterable<string>,
  tracked: readonly string[],
  limit = 20,
): string[] {
  const reached = new Set(walked);
  const missed = tracked.filter((file) => !reached.has(file));
  return missed.length > limit ? [...missed.slice(0, limit), `…and ${missed.length - limit} more`] : missed;
}
