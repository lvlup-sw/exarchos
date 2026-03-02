import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import { expandTilde, resolveScript } from './paths.js';

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

describe('resolveScript', () => {
  const originalEnv = process.env.EXARCHOS_PLUGIN_ROOT;

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original env state to avoid test pollution
    if (originalEnv === undefined) {
      delete process.env.EXARCHOS_PLUGIN_ROOT;
    } else {
      process.env.EXARCHOS_PLUGIN_ROOT = originalEnv;
    }
  });

  it('resolveScript_WithPluginRoot_ResolvesFromPluginScripts', () => {
    process.env.EXARCHOS_PLUGIN_ROOT = '/plugins/cache/exarchos';
    expect(resolveScript('verify-doc-links.sh')).toBe(
      '/plugins/cache/exarchos/scripts/verify-doc-links.sh',
    );
  });

  it('resolveScript_WithoutPluginRoot_FallsBackToClaudeHome', () => {
    delete process.env.EXARCHOS_PLUGIN_ROOT;
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    expect(resolveScript('foo.sh')).toBe('/home/testuser/.claude/scripts/foo.sh');
  });
});
