import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Resolve repo root (handles worktree paths)
const repoRoot = process.cwd();

describe('Core Plugin Structure', () => {
  describe('plugin.json', () => {
    it('pluginManifest_requiredFields_containsAllFields', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      expect(existsSync(pluginPath)).toBe(true);
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.name).toBe('exarchos');
      expect(plugin.version).toBe('2.0.0');
      expect(plugin.author).toEqual({ name: 'Levelup Software' });
      expect(plugin.commands).toBe('./commands/');
      expect(plugin.skills).toBe('./skills/');
      expect(plugin.hooks).toBe('./hooks/hooks.json');
      expect(plugin.mcpServers).toBe('./.mcp.json');
    });
  });

  describe('marketplace.json', () => {
    it('marketplaceManifest_structure_containsPluginEntry', () => {
      const marketplacePath = join(repoRoot, '.claude-plugin', 'marketplace.json');
      expect(existsSync(marketplacePath)).toBe(true);
      const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'));
      expect(marketplace.name).toBe('lvlup-sw');
      expect(marketplace.owner.name).toBe('Levelup Software');
      expect(marketplace.plugins).toHaveLength(1);
      expect(marketplace.plugins[0].name).toBe('exarchos');
      expect(marketplace.plugins[0].version).toBe('2.0.0');
      expect(marketplace.plugins[0].category).toBe('productivity');
    });
  });

  describe('.mcp.json', () => {
    it('mcpConfig_servers_includesExarchosAndGraphite', () => {
      const mcpPath = join(repoRoot, '.mcp.json');
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      expect(mcp).toHaveProperty('exarchos');
      expect(mcp).toHaveProperty('graphite');
      expect(mcp.exarchos.type).toBe('stdio');
      expect(mcp.graphite.command).toBe('gt');
      expect(mcp.graphite.args).toEqual(['mcp']);
    });
  });

  describe('hooks/hooks.json', () => {
    it('hooksConfig_allHooks_usePluginRootPaths', () => {
      const hooksPath = join(repoRoot, 'hooks', 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);
      const raw = readFileSync(hooksPath, 'utf-8');
      const hooks = JSON.parse(raw);

      // All 6 hook types present
      const hookTypes = Object.keys(hooks.hooks);
      expect(hookTypes).toContain('PreCompact');
      expect(hookTypes).toContain('SessionStart');
      expect(hookTypes).toContain('PreToolUse');
      expect(hookTypes).toContain('TaskCompleted');
      expect(hookTypes).toContain('TeammateIdle');
      expect(hookTypes).toContain('SubagentStart');

      // All paths use ${CLAUDE_PLUGIN_ROOT}
      expect(raw).not.toContain('{{CLI_PATH}}');
      expect(raw).toContain('${CLAUDE_PLUGIN_ROOT}');
    });

    it('hooksConfig_matcherPatterns_preserved', () => {
      const hooksPath = join(repoRoot, 'hooks', 'hooks.json');
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));

      expect(hooks.hooks.PreCompact[0].matcher).toBe('auto');
      expect(hooks.hooks.SessionStart[0].matcher).toBe('startup|resume');
      expect(hooks.hooks.PreToolUse[0].matcher).toBe('mcp__exarchos__.*');
    });
  });

  describe('settings.json', () => {
    it('settings_permissions_rationalizedToMinimalSet', () => {
      const settingsPath = join(repoRoot, 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const allow = settings.permissions.allow;

      // Core tools present
      expect(allow).toContain('Read');
      expect(allow).toContain('Write');
      expect(allow).toContain('Edit');
      expect(allow).toContain('mcp__*');

      // Language-specific tools removed
      expect(allow).not.toContain('Bash(dotnet:*)');
      expect(allow).not.toContain('Bash(cargo:*)');
      expect(allow).not.toContain('Bash(python:*)');
      expect(allow).not.toContain('Bash(ruby:*)');
      expect(allow).not.toContain('Bash(java:*)');
      expect(allow).not.toContain('Bash(terraform:*)');
      expect(allow).not.toContain('Bash(kubectl:*)');

      // Total count is reasonable (under 50)
      expect(allow.length).toBeLessThan(50);
    });
  });

  describe('package.json', () => {
    it('packageJson_filesArray_includesPluginDirectories', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.files).toContain('.claude-plugin');
      expect(pkg.files).toContain('hooks');
      expect(pkg.files).toContain('companion');
    });

    it('packageJson_scripts_includesValidation', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts.validate).toBe('bash scripts/validate-plugin.sh');
      expect(pkg.scripts['validate:companion']).toBe('bash scripts/validate-companion.sh');
    });

    it('packageJson_keywords_updatedForPlugin', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.keywords).toContain('claude-code-plugin');
      expect(pkg.keywords).toContain('agent-governance');
      expect(pkg.keywords).toContain('graphite');
      expect(pkg.keywords).toContain('event-sourcing');
    });
  });

  describe('obsolete files removed', () => {
    it('obsoletePlugin_removed_noLongerExists', () => {
      const oldPlugin = join(repoRoot, 'plugins', 'exarchos', '.claude-plugin', 'plugin.json');
      const oldMcp = join(repoRoot, 'plugins', 'exarchos', 'mcp-servers.json');
      expect(existsSync(oldPlugin)).toBe(false);
      expect(existsSync(oldMcp)).toBe(false);
    });
  });
});
