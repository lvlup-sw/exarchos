/**
 * Tests for the `stale-skill-dirs` doctor check (Task 011, DR-3/DR-8) — the
 * read-only residue finding for the onboard rename migration.
 */

import { describe, it, expect } from 'vitest';

import {
  checkStaleSkillDirs,
  staleSkillDirs,
  STALE_SKILL_DIRS_CHECK_NAME,
} from './stale-skill-dirs.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';

describe('stale-skill-dirs doctor check', () => {
  it('staleSkillDirs_NoOldNameDirs_Pass', () => {
    // Only LIVE (renamed-to) skill names present ⇒ nothing stale ⇒ Pass.
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

  it('staleSkillDirs_OldNameDirPresent_WarningWithFix', () => {
    // A renamed-away dir present in the project scope ⇒ Warning (+ fix). The
    // `plugin` category routes any remediation to the cli-only install step (the
    // migration) via the reconciler's classifyByCategory fallback.
    const result = checkStaleSkillDirs({
      home: '/home/u',
      projectRoot: '/proj',
      listDirs: (dir) =>
        dir.startsWith('/proj') ? ['brainstorming', 'ideate'] : [],
    });
    expect(result.status).toBe('Warning');
    expect(result.category).toBe('plugin');
    expect(result.fix).toBeDefined();
    // Names the stale dir, not the live one.
    expect(result.message).toContain('brainstorming');
    expect(result.message).not.toContain('/proj/.agents/skills/ideate');
  });

  it('staleSkillDirs_ScansBothUserAndProjectScopes', () => {
    // A stale dir only in the USER scope is still found (both scopes scanned).
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
    // No home ⇒ only the project scope is scanned; the check must not throw.
    const result = checkStaleSkillDirs({
      projectRoot: '/proj',
      listDirs: (dir) => (dir.startsWith('/proj') ? ['synthesis'] : []),
    });
    expect(result.status).toBe('Warning');
    expect(result.message).toContain('synthesis');
  });

  it('staleSkillDirs_RosterAdapter_ReadsHomeFromProbeEnv', async () => {
    // The CheckFn adapter resolves home from the probe env (HOME/USERPROFILE) and
    // returns a schema-valid Pass against a clean, non-existent scope.
    const probes = makeStubProbes({ env: { HOME: '/nonexistent-home-xyz' } });
    const result = await staleSkillDirs(probes, new AbortController().signal);
    expect(result.name).toBe(STALE_SKILL_DIRS_CHECK_NAME);
    expect(result.status).toBe('Pass');
  });
});
