import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Resolve repo root (handles worktree paths)
const repoRoot = process.cwd();
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;

describe('Core Plugin Structure', () => {
  describe('plugin.json', () => {
    it('pluginManifest_requiredFields_containsAllFields', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      expect(existsSync(pluginPath)).toBe(true);
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.name).toBe('exarchos');
      expect(plugin.version).toBe(pkgVersion);
      expect(plugin.author).toEqual({ name: 'LevelUp Software' });
      expect(plugin.commands).toBe('./commands/');
      expect(plugin.skills).toBe('./skills/');
      // hooks/hooks.json is auto-loaded by Claude Code — declaring it in plugin.json causes duplicates
      expect(plugin.hooks).toBeUndefined();
      expect(plugin.mcpServers).toBeDefined();
      expect(plugin.mcpServers.exarchos).toBeDefined();
      // Only the exarchos server should be bundled in plugin
      expect(Object.keys(plugin.mcpServers)).toEqual(['exarchos']);
    });

    it('PluginJson_McpServerEnv_IncludesExarchosPluginRoot', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.mcpServers.exarchos.env).toHaveProperty(
        'EXARCHOS_PLUGIN_ROOT',
        '${CLAUDE_PLUGIN_ROOT}',
      );
    });

    // Task 2.1 (v29-install-rewrite) — plugin.json must invoke bare `exarchos`
    // via PATH (Graphite-style), not `node` + a bundled JS fallback.
    // Phase: GREEN — plugin.json now invokes bare `exarchos mcp`.
    it('PluginJson_McpServerCommand_IsExarchosNotNode', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.mcpServers.exarchos.command).toBe('exarchos');
      expect(plugin.mcpServers.exarchos.args).toEqual(expect.arrayContaining(['mcp']));
      // Guard: no `node` sneaking in as command
      expect(plugin.mcpServers.exarchos.command).not.toBe('node');
    });

    it('PluginJson_HasNoBundledJsFallbacks', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const raw = readFileSync(pluginPath, 'utf-8');
      // No bundled-JS fallback paths
      expect(raw).not.toContain('dist/exarchos.js');
      expect(raw).not.toContain('dist/cli.js');
      // No `node` as a quoted string value (either the command or an arg)
      expect(raw).not.toContain('"node"');
    });

    // Task 2.4 (v29-install-rewrite) — plugin.json must declare
    // `metadata.compat.minBinaryVersion` so that
    // `checkPluginRootCompatibility()` (added in task 2.3) has a concrete
    // value to compare the running binary against. Missing or malformed
    // values degrade to "advisory" and silently mask drift.
    it('PluginJson_Metadata_DeclaresMinBinaryVersion', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.metadata).toBeDefined();
      expect(plugin.metadata.compat).toBeDefined();
      const min = plugin.metadata.compat.minBinaryVersion;
      expect(typeof min).toBe('string');
      expect(min.length).toBeGreaterThan(0);
      // Semver major.minor.patch prefix (build/prerelease suffixes allowed).
      expect(min).toMatch(/^\d+\.\d+\.\d+/);
    });

    // The declared minBinaryVersion must match the running MCP binary's
    // `SERVER_VERSION` constant. We read the constant out of the source file
    // rather than `await import(...)` it, because `servers/exarchos-mcp/src/index.ts`
    // has module-level side effects (event store wiring, dispatch context init)
    // that are expensive and unnecessary for this assertion.
    it('PluginJson_MinBinaryVersion_MatchesCurrentBinary', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));

      const mcpIndexPath = join(repoRoot, 'servers', 'exarchos-mcp', 'src', 'index.ts');
      const mcpIndexSrc = readFileSync(mcpIndexPath, 'utf-8');
      const match = mcpIndexSrc.match(/export\s+const\s+SERVER_VERSION\s*=\s*['"]([^'"]+)['"]/);
      expect(match).not.toBeNull();
      const serverVersion = match![1];

      expect(plugin.metadata.compat.minBinaryVersion).toBe(serverVersion);
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
      expect(hooks.hooks.PreToolUse[0].matcher).toBe('mcp__(plugin_exarchos_)?exarchos__.*');
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
    });

    it('packageJson_scripts_includesValidation', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts.validate).toBe('bash scripts/validate-plugin.sh');
    });

    it('packageJson_keywords_updatedForPlugin', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.keywords).toContain('claude-code-plugin');
      expect(pkg.keywords).toContain('agent-governance');
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
