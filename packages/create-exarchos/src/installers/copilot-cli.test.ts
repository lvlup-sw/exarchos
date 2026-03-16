import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { installExarchos, installCompanion } from './copilot-cli.js';

describe('Copilot CLI Installer', () => {
  let testDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    testDir = join(tmpdir(), `copilot-cli-installer-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('installExarchos_CopilotCli_WritesMcpConfigWithExarchosServer', () => {
    const mcpJsonPath = join(testDir, 'mcp-config.json');

    const result = installExarchos(mcpJsonPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers?.exarchos).toBeDefined();
    expect(config.mcpServers.exarchos.command).toBe('npx');
    expect(config.mcpServers.exarchos.args).toContain('@lvlup-sw/exarchos');
  });

  it('installCompanion_McpType_AddsToMcpConfig', () => {
    const mcpJsonPath = join(testDir, 'mcp-config.json');
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }));

    const result = installCompanion(
      {
        id: 'exa', name: 'exa', description: '', default: true,
        install: { 'copilot-cli': { mcp: { type: 'http', url: 'https://mcp.exa.ai/mcp' } } }
      },
      mcpJsonPath
    );
    expect(result.success).toBe(true);
    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers?.exa).toBeDefined();
    expect(config.mcpServers.exa.url).toBe('https://mcp.exa.ai/mcp');
  });

  it('installCompanion_CommandsType_RunsShellCommands', () => {
    const result = installCompanion({
      id: 'playwright', name: 'playwright', description: '', default: true,
      install: { 'copilot-cli': { commands: ['npx @playwright/cli install', 'npx @playwright/cli install --skills'] } }
    });
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      'npx @playwright/cli install',
      expect.any(Object)
    );
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      'npx @playwright/cli install --skills',
      expect.any(Object)
    );
  });

  it('installCompanion_SkillsType_RunsNpxSkillsAdd', () => {
    const result = installCompanion({
      id: 'axiom', name: 'axiom', description: '', default: true,
      install: { 'copilot-cli': { skills: 'lvlup-sw/axiom' } }
    });
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('npx skills add lvlup-sw/axiom'),
      expect.any(Object)
    );
  });

  it('installCompanion_NoCopilotCliConfig_Skipped', () => {
    const result = installCompanion({
      id: 'test', name: 'test', description: '', default: true,
      install: { 'claude-code': { plugin: 'test@test' } }
    });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it('installExarchos_ExistingMcpConfig_MergesConfig', () => {
    const mcpJsonPath = join(testDir, 'mcp-config.json');
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { existing: { command: 'node' } } }));

    const result = installExarchos(mcpJsonPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers.existing).toBeDefined();
    expect(config.mcpServers.exarchos).toBeDefined();
  });
});
