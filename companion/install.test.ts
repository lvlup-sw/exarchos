import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
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
      expect(settings.enabledPlugins['serena@claude-plugins-official']).toBe(true);
      expect(settings.enabledPlugins['context7@claude-plugins-official']).toBe(true);
      expect(result.pluginsEnabled).toHaveLength(2);
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
      expect(settings.enabledPlugins['serena@claude-plugins-official']).toBe(true);
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
      expect(settings.enabledPlugins['serena@claude-plugins-official']).toBe(true);
    });
  });

  describe('Error recovery', () => {
    it('companionInstall_malformedSettings_recoversGracefully', () => {
      mkdirSync(claudeHome, { recursive: true });
      writeFileSync(join(claudeHome, 'settings.json'), 'not valid json {{{');

      const result = installCompanion(claudeHome, claudeJsonPath);

      // Should succeed despite malformed settings
      expect(result.pluginsEnabled).toHaveLength(2);
      const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'));
      expect(settings.enabledPlugins['serena@claude-plugins-official']).toBe(true);
    });

    it('companionInstall_malformedMcpConfig_recoversGracefully', () => {
      writeFileSync(claudeJsonPath, 'broken json');

      const result = installCompanion(claudeHome, claudeJsonPath);

      expect(result.mcpServersAdded).toContain('microsoft-learn');
      const config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
      expect(config.mcpServers['microsoft-learn']).toBeDefined();
    });
  });

  describe('Content overlay installation', () => {
    it('installCompanion_createsRuleSymlinks', () => {
      const result = installCompanion(claudeHome, claudeJsonPath);
      const rulePath = join(claudeHome, 'rules/mcp-tool-guidance.md');
      expect(existsSync(rulePath)).toBe(true);
      expect(lstatSync(rulePath).isSymbolicLink()).toBe(true);
      expect(result.contentOverlays).toContain('rules/mcp-tool-guidance.md');
    });

    it('installCompanion_createsSkillOverlaySymlinks', () => {
      const result = installCompanion(claudeHome, claudeJsonPath);
      const overlayPath = join(claudeHome, 'skills/workflow-state/references/companion-mcp-reference.md');
      expect(existsSync(overlayPath)).toBe(true);
      expect(lstatSync(overlayPath).isSymbolicLink()).toBe(true);
      expect(result.contentOverlays).toContain('skills/workflow-state/references/companion-mcp-reference.md');
    });

    it('installCompanion_contentOverlays_idempotent', () => {
      installCompanion(claudeHome, claudeJsonPath);
      const result = installCompanion(claudeHome, claudeJsonPath);

      // Second run should report nothing new (symlinks already point to same source)
      expect(result.contentOverlays).toHaveLength(0);
    });

    it('installCompanion_existingFile_skipsWithWarning', () => {
      // Pre-create a non-symlink file at the target path
      mkdirSync(join(claudeHome, 'rules'), { recursive: true });
      writeFileSync(join(claudeHome, 'rules/mcp-tool-guidance.md'), 'existing content');

      const result = installCompanion(claudeHome, claudeJsonPath);

      // Should skip the rule overlay (file already exists and is not a symlink)
      expect(result.contentOverlays).not.toContain('rules/mcp-tool-guidance.md');
      // Original content should be preserved
      const content = readFileSync(join(claudeHome, 'rules/mcp-tool-guidance.md'), 'utf-8');
      expect(content).toBe('existing content');
    });
  });
});
