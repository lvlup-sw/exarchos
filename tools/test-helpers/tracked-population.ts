/**
 * Gives a guard a second authority for its denominator: the files that `git ls-files` tracks.
 *
 * A structural guard that scans the wrong tree, or part of it, still reports no violations.
 * `git ls-files` knows nothing about the recursion, exclusions or extension filter of a scanner.
 * When a walk misses tracked files, the difference names the missing modules.
 *
 * Git reports committed or staged files, so an untracked new module is not in the list.
 * The assertion is `tracked ⊆ walked`, so an untracked file can only make the walk larger.
 * Prefer {@link listTrackedFiles} to {@link countTrackedFiles}, because a failure then names the modules.
 */
import { execFileAsync } from './spawn.js';

/**
 * Excludes path segments by property, not by subtree name: `node_modules`, `dist` and each dot-directory.
 * `.claude/worktrees/` holds full sibling checkouts, so a walk into it counts each module many times.
 */
const EXCLUDED_BY_PROPERTY = (segment: string): boolean =>
  segment === 'node_modules' || segment === 'dist' || segment.startsWith('.');

export interface TrackedPopulationQuery {
  /** File extensions that constitute the population. Default: `['.ts']`. */
  readonly extensions?: readonly string[];
  /**
   * An extra rejection test over the `root`-relative, forward-slashed path.
   * It mirrors the exclusions of a scanner, so a shortfall means a broken walk, not a different population.
   */
  readonly exclude?: (relativePath: string) => boolean;
}

/**
 * Returns the files that `root` tracks and the query admits, `root`-relative, forward-slashed and sorted.
 * Rejects when the query resolves nothing, because an empty list makes each containment assertion pass.
 */
export async function listTrackedFiles(root: string, query: TrackedPopulationQuery = {}): Promise<string[]> {
  const extensions = query.extensions ?? ['.ts'];
  const pathspecs = extensions.map((extension) => `*${extension}`);
  const stdout = await execFileAsync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: root });

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
export async function countTrackedFiles(root: string, query: TrackedPopulationQuery = {}): Promise<number> {
  return (await listTrackedFiles(root, query)).length;
}

/**
 * Returns the tracked files that a walk did not reach, capped at `limit` for a legible message.
 * Extra files in the walk are not a finding, because an untracked file in a working tree is benign.
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
