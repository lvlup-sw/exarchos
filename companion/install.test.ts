import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import will fail until install.ts is created
import { installCompanion } from './src/install.js';

describe('Companion Installer', () => {
  let tempDir: string;
  let claudeHome: string;
  let claudeJsonPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'exarchos-companion-test-'));
    claudeHome = join(tempDir, '.claude');
    claudeJsonPath = join(tempDir, '.claude.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Plugin enablement', () => {
    it('companionInstall_enablesPlugins_inUserSettings', () => {
      const result = installCompanion(claudeHome, claudeJsonPath);

      const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'));
      expect(settings.enabledPlugins['github@claude-plugins-official']).toBe(true);
      expect(settings.enabledPlugins['serena@claude-plugins-official']).toBe(true);
      expect(settings.enabledPlugins['context7@claude-plugins-official']).toBe(true);
      expect(result.pluginsEnabled).toHaveLength(3);
    });

    it('companionInstall_existingSettings_mergesWithoutOverwrite', () => {
      // Pre-existing settings
      mkdirSync(claudeHome, { recursive: true });
      writeFileSync(
        join(claudeHome, 'settings.json'),
        JSON.stringify({ model: 'claude-opus-4-6', enabledPlugins: { 'custom@marketplace': true } })
      );

      installCompanion(claudeHome, claudeJsonPath);

      const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'));
      // Original settings preserved
      expect(settings.model).toBe('claude-opus-4-6');
      expect(settings.enabledPlugins['custom@marketplace']).toBe(true);
      // New plugins added
      expect(settings.enabledPlugins['github@claude-plugins-official']).toBe(true);
    });
  });

  describe('MCP server registration', () => {
    it('companionInstall_registersMcpServer_inClaudeJson', () => {
      const result = installCompanion(claudeHome, claudeJsonPath);

      const mcpConfig = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
      expect(mcpConfig.mcpServers['microsoft-learn']).toBeDefined();
      expect(mcpConfig.mcpServers['microsoft-learn'].type).toBe('http');
      expect(mcpConfig.mcpServers['microsoft-learn'].url).toBe('https://learn.microsoft.com/api/mcp');
      expect(result.mcpServersAdded).toContain('microsoft-learn');
    });

    it('companionInstall_existingMcpConfig_mergesWithoutOverwrite', () => {
      // Pre-existing MCP config
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({ mcpServers: { exarchos: { type: 'stdio', command: 'bun' } } })
      );

      installCompanion(claudeHome, claudeJsonPath);

      const mcpConfig = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
      // Original server preserved
      expect(mcpConfig.mcpServers.exarchos).toBeDefined();
      // New server added
      expect(mcpConfig.mcpServers['microsoft-learn']).toBeDefined();
    });

    it('companionInstall_alreadyInstalled_isIdempotent', () => {
      // Run twice
      installCompanion(claudeHome, claudeJsonPath);
      const result = installCompanion(claudeHome, claudeJsonPath);

      // Second run should report nothing new
      expect(result.pluginsEnabled).toHaveLength(0);
      expect(result.mcpServersAdded).toHaveLength(0);

      // Settings should be unchanged
      const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'));
      expect(settings.enabledPlugins['github@claude-plugins-official']).toBe(true);
    });
  });
});
