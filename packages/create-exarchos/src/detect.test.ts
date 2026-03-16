import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

import { detectEnvironment, isCommandAvailable } from './detect.js';

describe('Environment Detection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('detectEnvironment_ClaudeJsonPresent_ReturnsClaudeCode', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      typeof p === 'string' && p.endsWith('.claude.json')
    );

    expect(detectEnvironment()).toBe('claude-code');
  });

  it('detectEnvironment_ClaudeDirOnly_DoesNotDetectClaudeCode', () => {
    // ~/.claude/ directory alone (e.g. from playwright skills) should not trigger claude-code
    vi.mocked(existsSync).mockImplementation((p) =>
      typeof p === 'string' && p.endsWith('/.claude')
    );

    expect(detectEnvironment()).toBeNull();
  });

  it('detectEnvironment_CopilotDirPresent_ReturnsCopilotCli', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      typeof p === 'string' && p.includes('.copilot')
    );

    expect(detectEnvironment()).toBe('copilot-cli');
  });

  it('detectEnvironment_CursorDirInHome_ReturnsCursor', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      typeof p === 'string' && p.includes('.cursor')
    );

    expect(detectEnvironment()).toBe('cursor');
  });

  it('detectEnvironment_CursorDirInCwd_ReturnsCursor', () => {
    const cwdCursorPath = join(process.cwd(), '.cursor');
    vi.mocked(existsSync).mockImplementation((p) => {
      if (typeof p !== 'string') return false;
      return p === cwdCursorPath;
    });

    expect(detectEnvironment()).toBe('cursor');
  });

  it('detectEnvironment_BothClaudeAndCursor_PrefersClaudeCode', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    expect(detectEnvironment()).toBe('claude-code');
  });

  it('detectEnvironment_NeitherDetected_ReturnsNull', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(detectEnvironment()).toBeNull();
  });

  it('isCommandAvailable_ExistingCommand_ReturnsTrue', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('/usr/bin/node'));

    expect(isCommandAvailable('node')).toBe(true);
  });

  it('isCommandAvailable_MissingCommand_ReturnsFalse', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });

    expect(isCommandAvailable('nonexistent-command-xyz')).toBe(false);
  });

  it('isCommandAvailable_ShellMetachars_ReturnsFalse', () => {
    expect(isCommandAvailable('cmd; rm -rf /')).toBe(false);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
