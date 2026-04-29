/**
 * Tests for the install-skills CLI bridge.
 *
 * The bridge owns the cross-package import of `installSkills()` + the
 * embedded runtime maps. This test verifies that calling the bridge with
 * `agent: 'claude'` forwards the resolved runtime config through to the
 * installer — the contract end of the wire that `cli.test.ts` no longer
 * reaches once the bridge is mocked at the dispatcher boundary.
 *
 * Implements: DR-7 (install-skills CLI), task 1.5 of the v2.9.0 closeout
 * (#1201).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const installSkillsMock =
  vi.fn<(opts: Record<string, unknown>) => Promise<void>>();

vi.mock('../../../../src/install-skills.js', () => ({
  installSkills: (opts: Record<string, unknown>) => installSkillsMock(opts),
}));

vi.mock('../../../../src/runtimes/embedded.js', () => ({
  loadEmbeddedRuntimes: () => ({
    claude: { name: 'claude', skillsInstallPath: '~/.claude/skills' },
    generic: { name: 'generic', skillsInstallPath: '~/.agents/skills' },
  }),
}));

describe('install-skills bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installSkillsMock.mockResolvedValue();
  });

  it('runInstallSkills_PassesEmbeddedRuntimes_AndAgentName', async () => {
    const { runInstallSkills } = await import('./install-skills-bridge.js');
    await runInstallSkills({ agent: 'claude' });

    expect(installSkillsMock).toHaveBeenCalledTimes(1);
    const call = installSkillsMock.mock.calls[0]?.[0];
    expect(call?.agent).toBe('claude');
    // Embedded maps flow through as an array (the surface the existing
    // installer expects). Both required entries must be present so the
    // installer can find `claude` and fall back to `generic`.
    const runtimes = call?.runtimes as Array<{ name: string }> | undefined;
    expect(runtimes).toBeDefined();
    expect(runtimes?.some((r) => r.name === 'claude')).toBe(true);
    expect(runtimes?.some((r) => r.name === 'generic')).toBe(true);
  });
});
