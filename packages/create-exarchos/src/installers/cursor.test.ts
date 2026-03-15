import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { installExarchos, installCompanion } from './cursor.js';

describe('Cursor Installer', () => {
  let testDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    testDir = join(tmpdir(), `cursor-installer-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('installExarchos_Cursor_WritesMcpJsonWithExarchosServer', () => {
    const mcpJsonPath = join(testDir, 'mcp.json');

    const result = installExarchos(mcpJsonPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers?.exarchos).toBeDefined();
    expect(config.mcpServers.exarchos.command).toBe('npx');
    expect(config.mcpServers.exarchos.args).toContain('@lvlup-sw/exarchos');
  });

  it('installCompanion_McpType_AddsToCursorMcpJson', () => {
    const mcpJsonPath = join(testDir, 'mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }));

    const result = installCompanion(
      {
        id: 'microsoft-learn', name: 'microsoft-learn', description: '', default: false,
        install: { cursor: { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } } }
      },
      mcpJsonPath
    );
    expect(result.success).toBe(true);
    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers?.['microsoft-learn']).toBeDefined();
  });

  it('installCompanion_SkillsType_RunsNpxSkillsAdd', () => {
    const result = installCompanion({
      id: 'axiom', name: 'axiom', description: '', default: true,
      install: { cursor: { skills: 'lvlup-sw/axiom' } }
    });
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('npx skills add lvlup-sw/axiom'),
      expect.any(Object)
    );
  });

  it('installExarchos_ExistingMcpJson_MergesConfig', () => {
    const mcpJsonPath = join(testDir, 'mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { existing: { command: 'node' } } }));

    const result = installExarchos(mcpJsonPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers.existing).toBeDefined();
    expect(config.mcpServers.exarchos).toBeDefined();
  });
});
