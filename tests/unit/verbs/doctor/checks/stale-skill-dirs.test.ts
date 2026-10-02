/**
 * Tests for the `stale-skill-dirs` doctor check. The check reads skill directory
 * names and reports each old skill name that remains after the onboard renames.
 */

import { describe, it, expect } from 'vitest';

import {
  checkStaleSkillDirs,
  staleSkillDirs,
  STALE_SKILL_DIRS_CHECK_NAME,
} from '../../../../../src/verbs/doctor/checks/stale-skill-dirs.js';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';

describe('stale-skill-dirs doctor check', () => {
  it('staleSkillDirs_NoOldNameDirs_Pass', () => {
    const result = checkStaleSkillDirs({
      home: '/home/u',
      projectRoot: '/proj',
      listDirs: () => ['ideate', 'plan', 'delegate'],
    });
    expect(result.name).toBe(STALE_SKILL_DIRS_CHECK_NAME);
    expect(result.category).toBe('plugin');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  /**
   * The `plugin` category routes the fix to the cli-only install step through the
   * reconciler fallback by category. The message names the stale directory, not the live one.
   */
  it('staleSkillDirs_OldNameDirPresent_WarningWithFix', () => {
    const result = checkStaleSkillDirs({
      home: '/home/u',
      projectRoot: '/proj',
      listDirs: (dir) =>
        dir.startsWith('/proj') ? ['brainstorming', 'ideate'] : [],
    });
    expect(result.status).toBe('Warning');
    expect(result.category).toBe('plugin');
    expect(result.fix).toBeDefined();
    expect(result.message).toContain('brainstorming');
    expect(result.message).not.toContain('/proj/.agents/skills/ideate');
  });

  it('staleSkillDirs_ScansBothUserAndProjectScopes', () => {
    const result = checkStaleSkillDirs({
      home: '/home/u',
      projectRoot: '/proj',
      listDirs: (dir) =>
        dir.startsWith('/home/u') ? ['workflow-state'] : [],
    });
    expect(result.status).toBe('Warning');
    expect(result.message).toContain('workflow-state');
  });

  it('staleSkillDirs_HomeUnresolvable_ProjectScopeOnly_NeverThrows', () => {
    const result = checkStaleSkillDirs({
      projectRoot: '/proj',
      listDirs: (dir) => (dir.startsWith('/proj') ? ['synthesis'] : []),
    });
    expect(result.status).toBe('Warning');
    expect(result.message).toContain('synthesis');
  });

  /**
   * The adapter reads the home from `HOME` or `USERPROFILE` in the probe env. The
   * home here does not exist, and the project scope is the current directory.
   */
  it('staleSkillDirs_RosterAdapter_ReadsHomeFromProbeEnv', async () => {
    const probes = makeStubProbes({ env: { HOME: '/nonexistent-home-xyz' } });
    const result = await staleSkillDirs(probes, new AbortController().signal);
    expect(result.name).toBe(STALE_SKILL_DIRS_CHECK_NAME);
    expect(result.status).toBe('Pass');
  });
});
