/**
 * stale-skill-dirs — the read-only `doctor` finding for the Task 011 onboard
 * rename migration (DR-3/DR-8).
 *
 * The DR-3 atomic rename wave renamed 9 skills, so a prior-release install can
 * carry STALE OLD-NAME skill dirs (`brainstorming`, `delegation`, …) on disk.
 * `onboard`'s install step removes the ones it can prove are ours (Task 010
 * manifest / Task 023 legacy-render hash) and PRESERVES any it cannot — a
 * modified or unrecognized dir is never deleted. This check surfaces the residue
 * read-only: it reports every renamed-away dir still present in the canonical
 * `.agents/skills` install scopes so an operator can see what remains.
 *
 *   - no stale old-name dirs present   ⇒ Pass
 *   - one or more present              ⇒ Warning (+ `fix`)
 *   - home unresolvable                ⇒ project scope only (never throws)
 *
 * Classification: the check's `category` is `plugin`, so the reconciler's
 * `classifyByCategory` fallback routes any remediable finding to the cli-only
 * INSTALL step — i.e. the very migration that removes provenance-matched dirs and
 * re-preserves the rest. No dedicated `CHECK_CLASSIFICATION` entry is required:
 * the finding degrades to the sensible install-surface default by construction
 * (a modified dir legitimately persists across re-runs, so this is a Warning the
 * operator resolves by hand, not an auto-fix).
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';
import { RENAMED_AWAY_SKILL_DIRS } from '../../onboard/install.js';

/** The stable doctor-check name (its identity in the doctor output). */
export const STALE_SKILL_DIRS_CHECK_NAME = 'stale-skill-dirs';

/** Injected reads + scope roots for {@link checkStaleSkillDirs} (test seam). */
export interface StaleSkillDirsDeps {
  /** User home for the `~/.agents/skills` scope. Omit ⇒ project scope only. */
  readonly home?: string;
  /** Project root for the `<projectRoot>/.agents/skills` scope. Default `process.cwd()`. */
  readonly projectRoot?: string;
  /** List directory entry names (non-throwing; absent dir ⇒ `[]`). */
  readonly listDirs?: (dir: string) => string[];
}

/** Real `node:fs` directory-name lister (only sub-directories; absent ⇒ `[]`). */
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
  if (deps.home) dirs.push(join(deps.home, '.agents', 'skills'));
  dirs.push(join(deps.projectRoot ?? process.cwd(), '.agents', 'skills'));
  return dirs;
}

/**
 * Diagnose stale old-name skill dirs across the canonical install scopes. Pure +
 * read-only: it lists directory names and flags any that is a
 * {@link RENAMED_AWAY_SKILL_DIRS} entry. Never mutates the filesystem.
 */
export function checkStaleSkillDirs(deps: StaleSkillDirsDeps = {}): CheckResult {
  const start = Date.now();
  const base = { category: 'plugin' as const, name: STALE_SKILL_DIRS_CHECK_NAME };
  const listDirs = deps.listDirs ?? defaultListDirs;
  const stale = new Set(RENAMED_AWAY_SKILL_DIRS);

  const found: string[] = [];
  for (const dir of scopeDirs(deps)) {
    for (const name of listDirs(dir)) {
      if (stale.has(name)) found.push(join(dir, name));
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
 * Roster {@link CheckFn} adapter. Resolves the user home from the probe env
 * (mirroring `retired-hooks-present`) and the project root from `process.cwd()`
 * (mirroring `onramp-block-drift`), then hands off to {@link checkStaleSkillDirs}.
 */
export const staleSkillDirs: CheckFn = async (probes): Promise<CheckResult> => {
  const home = probes.env.HOME ?? probes.env.USERPROFILE;
  return checkStaleSkillDirs({
    ...(home ? { home } : {}),
    projectRoot: process.cwd(),
  });
};
