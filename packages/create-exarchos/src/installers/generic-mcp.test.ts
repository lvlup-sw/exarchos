import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installExarchos, installCompanion } from './generic-mcp.js';

describe('Generic MCP Installer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `generic-mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('installExarchos_GenericMcp_WritesDotMcpJson', () => {
    const mcpJsonPath = join(testDir, '.mcp.json');

    const result = installExarchos(mcpJsonPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers?.exarchos).toBeDefined();
    expect(config.mcpServers.exarchos.command).toBe('npx');
  });

  it('installCompanion_McpType_AddsToDotMcpJson', () => {
    const mcpJsonPath = join(testDir, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }));

    const result = installCompanion(
      {
        id: 'microsoft-learn', name: 'microsoft-learn', description: '', default: false,
        install: { 'generic-mcp': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } } }
      },
      mcpJsonPath
    );
    expect(result.success).toBe(true);
    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers?.['microsoft-learn']).toBeDefined();
  });

  it('installExarchos_ExistingMcpJson_MergesConfig', () => {
    const mcpJsonPath = join(testDir, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { other: { command: 'test' } } }));

    const result = installExarchos(mcpJsonPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.exarchos).toBeDefined();
  });
});
