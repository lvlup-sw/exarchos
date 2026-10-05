import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The repository root is the working directory of the test run. */
const repoRoot = process.cwd();
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;

describe('Core Plugin Structure', () => {
  describe('plugin.json', () => {
    /**
     * Claude Code loads `hooks/hooks.json` automatically, so a `hooks` field in
     * `plugin.json` registers each hook twice. The plugin bundles only the
     * `exarchos` server.
     */
    it('pluginManifest_requiredFields_containsAllFields', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      expect(existsSync(pluginPath)).toBe(true);
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.name).toBe('exarchos');
      expect(plugin.version).toBe(pkgVersion);
      expect(plugin.author).toEqual({ name: 'LevelUp Software' });
      expect(plugin.commands).toBe('./rendered/commands/');
      expect(plugin.skills).toBe('./rendered/skills/');
      expect(plugin.hooks).toBeUndefined();
      expect(plugin.mcpServers).toBeDefined();
      expect(plugin.mcpServers.exarchos).toBeDefined();
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

    /** `plugin.json` must invoke the bare `exarchos` binary from `PATH`, not `node` with a bundled JS file. */
    it('PluginJson_McpServerCommand_IsExarchosNotNode', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.mcpServers.exarchos.command).toBe('exarchos');
      expect(plugin.mcpServers.exarchos.args).toEqual(expect.arrayContaining(['mcp']));
      expect(plugin.mcpServers.exarchos.command).not.toBe('node');
    });

    it('PluginJson_HasNoBundledJsFallbacks', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const raw = readFileSync(pluginPath, 'utf-8');
      expect(raw).not.toContain('dist/exarchos.js');
      expect(raw).not.toContain('dist/cli.js');
      expect(raw).not.toContain('"node"');
    });

    /**
     * `checkPluginRootCompatibility()` compares the binary version with
     * `metadata.compat.minBinaryVersion`. If the value is absent or not a string,
     * the check is only advisory and hides drift.
     */
    it('PluginJson_Metadata_DeclaresMinBinaryVersion', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
      expect(plugin.metadata).toBeDefined();
      expect(plugin.metadata.compat).toBeDefined();
      const min = plugin.metadata.compat.minBinaryVersion;
      expect(typeof min).toBe('string');
      expect(min.length).toBeGreaterThan(0);
      expect(min).toMatch(/^\d+\.\d+\.\d+/);
    });

    /**
     * The declared `minBinaryVersion` must equal the `SERVER_VERSION` constant. The
     * test reads the constant from the source text and does not import
     * `src/index.ts`, the entry point of the binary.
     */
    it('PluginJson_MinBinaryVersion_MatchesCurrentBinary', () => {
      const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
      const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));

      const mcpIndexPath = join(repoRoot, 'src', 'index.ts');
      const mcpIndexSrc = readFileSync(mcpIndexPath, 'utf-8');
      const match = mcpIndexSrc.match(/export\s+const\s+SERVER_VERSION\s*=\s*['"]([^'"]+)['"]/);
      expect(match).not.toBeNull();
      const serverVersion = match![1];

      expect(plugin.metadata.compat.minBinaryVersion).toBe(serverVersion);
    });
  });

  describe('hooks/hooks.json', () => {
    /**
     * The hook layer is observe-only. It declares exactly two hooks: `SessionStart`
     * for binding and `SubagentStop` for token telemetry. No enforcement hook, no
     * `SessionEnd` hook and no `PreCompact` hook is present. The raw text holds no
     * unrendered `{{CLI_PATH}}` placeholder.
     */
    it('hooksConfig_declaredHooks_areObserverOnly', () => {
      const hooksPath = join(repoRoot, 'hooks', 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);
      const raw = readFileSync(hooksPath, 'utf-8');
      const hooks = JSON.parse(raw);

      const hookTypes = Object.keys(hooks.hooks);
      expect(hookTypes).toHaveLength(2);

      expect(hookTypes).toContain('SessionStart');
      expect(hookTypes).toContain('SubagentStop');
      expect(hookTypes).not.toContain('SessionEnd');

      expect(hookTypes).not.toContain('PreToolUse');
      expect(hookTypes).not.toContain('TaskCompleted');
      expect(hookTypes).not.toContain('TeammateIdle');
      expect(hookTypes).not.toContain('SubagentStart');

      expect(hookTypes).not.toContain('PreCompact');

      expect(raw).not.toContain('{{CLI_PATH}}');
    });

    it('hooksConfig_matcherPatterns_preserved', () => {
      const hooksPath = join(repoRoot, 'hooks', 'hooks.json');
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));

      expect(hooks.hooks.SessionStart[0].matcher).toBe('startup|resume');
      expect(hooks.hooks.SubagentStop[0].matcher).toBe('*');
    });
  });

  describe('settings.json', () => {
    it('settings_permissions_rationalizedToMinimalSet', () => {
      const settingsPath = join(repoRoot, 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const allow = settings.permissions.allow;

      expect(allow).toContain('Read');
      expect(allow).toContain('Write');
      expect(allow).toContain('Edit');
      expect(allow).toContain('mcp__*');

      expect(allow).not.toContain('Bash(dotnet:*)');
      expect(allow).not.toContain('Bash(cargo:*)');
      expect(allow).not.toContain('Bash(python:*)');
      expect(allow).not.toContain('Bash(ruby:*)');
      expect(allow).not.toContain('Bash(java:*)');
      expect(allow).not.toContain('Bash(terraform:*)');
      expect(allow).not.toContain('Bash(kubectl:*)');

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

    /**
     * `validate` runs an aggregating runner, and its steps are data in
     * `tools/audit/gates/validate-manifest.json`. An `&&` chain skips each gate
     * after the first red step. Thus the test asserts that the manifest declares
     * the `plugin-packaging` step. An empty manifest must not pass as a clean run.
     */
    it('packageJson_scripts_includesValidation', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts.validate).toBe('node tools/audit/gates/run-validate.mjs');

      const manifest = JSON.parse(
        readFileSync(join(repoRoot, 'tools', 'audit', 'gates', 'validate-manifest.json'), 'utf-8'),
      );
      const ids = manifest.steps.map((s: { id: string }) => s.id);
      expect(ids).toContain('plugin-packaging');
      expect(manifest.steps.length).toBeGreaterThan(0);
    });

    it('packageJson_keywords_updatedForPlugin', () => {
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.keywords).toContain('claude-code-plugin');
      expect(pkg.keywords).toContain('agent-governance');
      expect(pkg.keywords).toContain('event-sourcing');
    });
  });

  /**
   * `.claude-plugin/packaging-policy.json` is the single statement of the packaging
   * policy, and the gate `tools/audit/gates/validate-plugin.mjs` reads it too. These
   * cases assert that the expectations of this suite agree with the policy. An edit
   * to only one of the two fails here.
   */
  describe('packaging policy agreement (task 064, DR-24)', () => {
    const policy = JSON.parse(
      readFileSync(join(repoRoot, '.claude-plugin', 'packaging-policy.json'), 'utf-8'),
    );

    it('PackagingPolicy_HookSet_AgreesWithThisSuite', () => {
      const expected = policy.hooks.expected.map((h: { type: string }) => h.type).sort();
      const retired = policy.hooks.retired.map((h: { type: string }) => h.type);
      expect(expected).toEqual(['SessionStart', 'SubagentStop']);
      for (const t of ['PreToolUse', 'TaskCompleted', 'TeammateIdle', 'SubagentStart', 'PreCompact', 'SessionEnd']) {
        expect(retired, `${t} must stay recorded as retired`).toContain(t);
      }
      expect(policy.hooks.exact).toBe(true);
    });

    it('PackagingPolicy_ManifestFields_AgreeWithThisSuite', () => {
      const required = policy.manifest.requiredFields.map((f: { field: string }) => f.field);
      const forbidden = policy.manifest.forbiddenFields.map((f: { field: string }) => f.field);
      for (const f of ['name', 'version', 'commands', 'skills', 'mcpServers']) {
        expect(required, `${f} must stay required`).toContain(f);
      }
      expect(forbidden, 'declaring `hooks` double-registers every hook').toContain('hooks');
      expect(policy.manifest.mcpServers.expected.map((s: { name: string }) => s.name)).toEqual(['exarchos']);
      expect(policy.manifest.mcpServers.exact).toBe(true);
    });

    /** A policy that forbids a file which the tree holds is a rule that nothing can satisfy. */
    it('PackagingPolicy_ForbidsTheStandaloneMcpJson_AndTheRepoHasNone', () => {
      const forbidden = policy.forbiddenFiles.map((f: { path: string }) => f.path);
      expect(forbidden).toContain('.mcp.json');
      expect(existsSync(join(repoRoot, '.mcp.json'))).toBe(false);
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
