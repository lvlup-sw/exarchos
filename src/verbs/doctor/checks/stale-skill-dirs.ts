/**
 * stale-skill-dirs: a read-only doctor check for skill directories that still
 * carry an old skill name after the skill renames.
 *
 * The `onboard` install step removes old-name directories that it can prove it
 * installed. It keeps a modified or unknown directory. This check reports each
 * old-name directory that remains in the `.agents/skills` scopes. It gives Pass
 * when none remain and Warning with a `fix` when some remain.
 *
 * The category is `plugin`, so the reconciler routes the finding to the
 * cli-only install step. A modified directory stays across re-runs, and the
 * operator removes it by hand.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';
import { RENAMED_AWAY_SKILL_DIRS } from '../../onboard/install.js';
import { toPosix } from '../../../utils/paths.js';

/** The stable doctor-check name (its identity in the doctor output). */
export const STALE_SKILL_DIRS_CHECK_NAME = 'stale-skill-dirs';

/** Injected reads + scope roots for {@link checkStaleSkillDirs} (test seam). */
export interface StaleSkillDirsDeps {
  /** User home for the `~/.agents/skills` scope. Omit ⇒ project scope only. */
  readonly home?: string;
  /** Project root for the `<projectRoot>/.agents/skills` scope. Default `process.cwd()`. */
  readonly projectRoot?: string;
  /** Lists directory entry names. It does not throw, and an absent directory gives `[]`. */
  readonly listDirs?: (dir: string) => string[];
}

/** Lists the sub-directories and symlinks of `dir` with `node:fs`. An absent directory gives `[]`. */
function defaultListDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Resolve the canonical `.agents/skills` scope dirs (user + project). */
function scopeDirs(deps: StaleSkillDirsDeps): string[] {
  const dirs: string[] = [];
  if (deps.home) dirs.push(toPosix(join(deps.home, '.agents', 'skills')));
  dirs.push(toPosix(join(deps.projectRoot ?? process.cwd(), '.agents', 'skills')));
  return dirs;
}

/**
 * Finds old-name skill directories in the install scopes. It only reads
 * directory names and flags each {@link RENAMED_AWAY_SKILL_DIRS} entry.
 */
export function checkStaleSkillDirs(deps: StaleSkillDirsDeps = {}): CheckResult {
  const start = Date.now();
  const base = { category: 'plugin' as const, name: STALE_SKILL_DIRS_CHECK_NAME };
  const listDirs = deps.listDirs ?? defaultListDirs;
  const stale = new Set(RENAMED_AWAY_SKILL_DIRS);

  const found: string[] = [];
  for (const dir of scopeDirs(deps)) {
    for (const name of listDirs(dir)) {
      if (stale.has(name)) found.push(toPosix(join(dir, name)));
    }
  }

  if (found.length === 0) {
    return {
      ...base,
      status: 'Pass',
      message: 'No stale renamed (old-name) skill directories present.',
      durationMs: Date.now() - start,
    };
  }

  return {
    ...base,
    status: 'Warning',
    message:
      `${found.length} stale renamed skill director${found.length === 1 ? 'y' : 'ies'} ` +
      `present: ${found.join(', ')}.`,
    fix:
      'Run `exarchos onboard` (or `exarchos doctor --fix`) to remove the ' +
      'provenance-matched old-name skill directories; any modified or unrecognized ' +
      'directory is preserved and must be reviewed and removed by hand.',
    durationMs: Date.now() - start,
  };
}

/**
 * The roster {@link CheckFn} adapter. It reads the user home from the probe env
 * and the project root from `process.cwd()`.
 */
export const staleSkillDirs: CheckFn = async (probes): Promise<CheckResult> => {
  const home = probes.env.HOME ?? probes.env.USERPROFILE;
  return checkStaleSkillDirs({
    ...(home ? { home } : {}),
    projectRoot: process.cwd(),
  });
};
