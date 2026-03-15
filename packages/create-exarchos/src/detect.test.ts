import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// We'll mock fs and child_process
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

import { detectEnvironment, isCommandAvailable } from './detect.js';

describe('Environment Detection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('detectEnvironment_ClaudeDirAndClaudeOnPath_ReturnsClaudeCode', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      typeof p === 'string' && p.includes('.claude')
    );
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'));

    expect(detectEnvironment()).toBe('claude-code');
  });

  it('detectEnvironment_ClaudeDirOnly_ReturnsClaudeCode', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      typeof p === 'string' && p.includes('.claude')
    );
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

    expect(detectEnvironment()).toBe('claude-code');
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
      // Only the cwd-based .cursor path exists
      return p === cwdCursorPath;
    });

    expect(detectEnvironment()).toBe('cursor');
  });

  it('detectEnvironment_BothClaudeAndCursor_PrefersClaudeCode', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'));

    expect(detectEnvironment()).toBe('claude-code');
  });

  it('detectEnvironment_NeitherDetected_ReturnsNull', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(detectEnvironment()).toBeNull();
  });

  it('isCommandAvailable_ExistingCommand_ReturnsTrue', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/node'));

    expect(isCommandAvailable('node')).toBe(true);
  });

  it('isCommandAvailable_MissingCommand_ReturnsFalse', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

    expect(isCommandAvailable('nonexistent-command-xyz')).toBe(false);
  });
});
