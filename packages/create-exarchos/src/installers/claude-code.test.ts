import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process for command execution
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { installExarchos, installCompanion } from './claude-code.js';

describe('Claude Code Installer', () => {
  let testDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    testDir = join(tmpdir(), `cc-installer-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('installExarchos_ClaudeCode_RunsPluginInstallCommand', () => {
    const result = installExarchos();
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('claude plugin install exarchos@lvlup-sw'),
      expect.any(Object)
    );
  });

  it('installCompanion_PluginType_RunsPluginInstall', () => {
    const result = installCompanion({
      id: 'axiom', name: 'axiom', description: '', default: true,
      install: { 'claude-code': { plugin: 'axiom@lvlup-sw' } }
    });
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('claude plugin install axiom@lvlup-sw'),
      expect.any(Object)
    );
  });

  it('installCompanion_McpType_WritesToClaudeJson', () => {
    const configPath = join(testDir, '.claude.json');
    writeFileSync(configPath, '{}');

    const result = installCompanion(
      {
        id: 'microsoft-learn', name: 'microsoft-learn', description: '', default: false,
        install: { 'claude-code': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } } }
      },
      configPath
    );
    expect(result.success).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers?.['microsoft-learn']).toBeDefined();
    expect(config.mcpServers?.['microsoft-learn']?.url).toBe('https://learn.microsoft.com/api/mcp');
  });

  it('installCompanion_NoClaudeCodeConfig_CreatesNew', () => {
    const configPath = join(testDir, 'new-claude.json');

    const result = installCompanion(
      {
        id: 'microsoft-learn', name: 'microsoft-learn', description: '', default: false,
        install: { 'claude-code': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } } }
      },
      configPath
    );
    expect(result.success).toBe(true);
  });

  it('installExarchos_CommandFails_ReturnsError', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('command failed'); });

    const result = installExarchos();
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
