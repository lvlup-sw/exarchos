import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { installExarchos, installCompanion } from './cli.js';

describe('CLI Installer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(execSync).mockReturnValue('');
  });

  it('installExarchos_Cli_RunsNpmInstallGlobal', () => {
    const result = installExarchos();
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('npm install -g @lvlup-sw/exarchos'),
      expect.any(Object)
    );
  });

  it('installExarchos_CommandFails_ReturnsError', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('permission denied'); });

    const result = installExarchos();
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
