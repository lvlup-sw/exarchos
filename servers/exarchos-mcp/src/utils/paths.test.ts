import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import { expandTilde } from './paths.js';

describe('expandTilde', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expands leading tilde to home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    expect(expandTilde('~/.claude/workflow-state')).toBe('/home/testuser/.claude/workflow-state');
  });

  it('expands bare tilde to home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    expect(expandTilde('~')).toBe('/home/testuser');
  });

  it('returns absolute paths unchanged', () => {
    expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('returns relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path');
  });

  it('does not expand tilde in middle of path', () => {
    expect(expandTilde('/some/~/path')).toBe('/some/~/path');
  });

  it('returns empty string unchanged', () => {
    expect(expandTilde('')).toBe('');
  });
});
