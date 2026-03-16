import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the modules that do actual system work
vi.mock('./detect.js', () => ({
  detectEnvironment: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  checkbox: vi.fn(),
}));

// Mock all installers
vi.mock('./installers/claude-code.js', () => ({
  installExarchos: vi.fn(() => ({ success: true, name: 'exarchos' })),
  installCompanion: vi.fn((c) => ({ success: true, name: c.name })),
}));

vi.mock('./installers/copilot-cli.js', () => ({
  installExarchos: vi.fn(() => ({ success: true, name: 'exarchos' })),
  installCompanion: vi.fn((c) => ({ success: true, name: c.name })),
}));

vi.mock('./installers/cursor.js', () => ({
  installExarchos: vi.fn(() => ({ success: true, name: 'exarchos' })),
  installCompanion: vi.fn((c) => ({ success: true, name: c.name })),
}));

vi.mock('./installers/generic-mcp.js', () => ({
  installExarchos: vi.fn(() => ({ success: true, name: 'exarchos' })),
  installCompanion: vi.fn((c) => ({ success: true, name: c.name })),
}));

vi.mock('./installers/cli.js', () => ({
  installExarchos: vi.fn(() => ({ success: true, name: 'exarchos' })),
  installCompanion: vi.fn((c) => ({ success: true, name: c.name, skipped: true })),
}));

import { run } from './index.js';
import { detectEnvironment } from './detect.js';
import * as claudeCodeInstaller from './installers/claude-code.js';
import * as cursorInstaller from './installers/cursor.js';

describe('Main Orchestration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Suppress console output in tests
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('run_NonInteractive_DetectsEnvInstallsDefaults', async () => {
    vi.mocked(detectEnvironment).mockReturnValue('claude-code');

    await run(['--yes']);

    expect(claudeCodeInstaller.installExarchos).toHaveBeenCalled();
    // Should install default companions (axiom, impeccable, serena, context7, exa, playwright)
    expect(claudeCodeInstaller.installCompanion).toHaveBeenCalledTimes(6);
  });

  it('run_NonInteractive_WithEnvFlag_UsesSpecifiedEnv', async () => {
    await run(['--yes', '--env', 'cursor']);

    expect(cursorInstaller.installExarchos).toHaveBeenCalled();
    expect(detectEnvironment).not.toHaveBeenCalled();
  });

  it('run_NonInteractive_WithExcludes_SkipsExcluded', async () => {
    vi.mocked(detectEnvironment).mockReturnValue('claude-code');

    await run(['--yes', '--no-axiom']);

    expect(claudeCodeInstaller.installExarchos).toHaveBeenCalled();
    // Should install 5 companions (impeccable, serena, context7, exa, playwright) — axiom excluded
    expect(claudeCodeInstaller.installCompanion).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(claudeCodeInstaller.installCompanion).mock.calls;
    const companionIds = calls.map(c => c[0].id);
    expect(companionIds).not.toContain('axiom');
  });

  it('run_ExarchosInstallFails_ReportsError', async () => {
    vi.mocked(detectEnvironment).mockReturnValue('claude-code');
    vi.mocked(claudeCodeInstaller.installExarchos).mockReturnValue({
      success: false, name: 'exarchos', error: 'network error'
    });

    // Should not throw — graceful error handling
    await expect(run(['--yes'])).resolves.not.toThrow();
  });

  it('run_CompanionInstallFails_ContinuesWithOthers', async () => {
    vi.mocked(detectEnvironment).mockReturnValue('claude-code');
    let callCount = 0;
    vi.mocked(claudeCodeInstaller.installCompanion).mockImplementation((c) => {
      callCount++;
      if (callCount === 1) return { success: false, name: c.name, error: 'failed' };
      return { success: true, name: c.name };
    });

    await run(['--yes']);

    // Should have tried all 6 companions despite first failure
    expect(claudeCodeInstaller.installCompanion).toHaveBeenCalledTimes(6);
  });
});
