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
      expect(plugin.commands).toBe('./rendered/commands/');
      expect(plugin.skills).toBe('./rendered/skills/');
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
    // rather than `await import(...)` it, because `src/index.ts`
    // has module-level side effects (event store wiring, dispatch context init)
    // that are expensive and unnecessary for this assertion.
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
    // #1476: the hook layer is observe-only. The four enforcement/control
    // hooks (PreToolUse/guard, TaskCompleted/task-gate, TeammateIdle/
    // teammate-gate, SubagentStart/subagent-context) were excised; only the
    // two lifecycle observers remain. See
    // docs/adrs/2026-05-24-hook-layer-observe-only.md.
    it('hooksConfig_declaredHooks_areObserverOnly', () => {
      const hooksPath = join(repoRoot, 'hooks', 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);
      const raw = readFileSync(hooksPath, 'utf-8');
      const hooks = JSON.parse(raw);

      const hookTypes = Object.keys(hooks.hooks);
      // Two observe-only hooks: SessionStart + SubagentStop. SessionEnd was
      // dropped everywhere in DR-7 (Task 016 hook-surface shrink).
      expect(hookTypes).toHaveLength(2);

      // Observer hooks (#1485: SessionStart binding; #1525: SubagentStop token
      // telemetry). SessionEnd provenance retired in DR-7.
      expect(hookTypes).toContain('SessionStart');
      expect(hookTypes).toContain('SubagentStop');
      expect(hookTypes).not.toContain('SessionEnd');

      // Retired enforcement/control hooks must not be present.
      expect(hookTypes).not.toContain('PreToolUse');
      expect(hookTypes).not.toContain('TaskCompleted');
      expect(hookTypes).not.toContain('TeammateIdle');
      expect(hookTypes).not.toContain('SubagentStart');

      // T-40 removal stays gone. (SubagentStop is now a live observer — #1525.)
      expect(hookTypes).not.toContain('PreCompact');

      // Sanity: no orphaned ${CLAUDE_PLUGIN_ROOT} placeholder breakage.
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
      // `validate` used to be an inline `&&` chain, and this test asserted a
      // substring of it. Task 064 replaced the chain with an aggregating runner
      // whose steps are DATA (tools/audit/gates/validate-manifest.json), because an `&&`
      // chain whose first step is red makes every later gate skipped-as-passed:
      // measured 2026-08-07, 1 of 9 declared steps executed.
      //
      // So the assertion moves to the data. The plugin-packaging gate must
      // still be a declared step — but a substring check on a command line can
      // no longer see that, and pretending otherwise is what let the previous
      // drift hide.
      const pkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts.validate).toBe('node tools/audit/gates/run-validate.mjs');

      const manifest = JSON.parse(
        readFileSync(join(repoRoot, 'tools', 'audit', 'gates', 'validate-manifest.json'), 'utf-8'),
      );
      const ids = manifest.steps.map((s: { id: string }) => s.id);
      expect(ids).toContain('plugin-packaging');
      // Non-empty denominator: a manifest that declares nothing must never be
      // mistaken for a validate run that had nothing to complain about.
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

  // Task 064 (DR-24). This suite and tools/audit/gates/validate-plugin.sh were two
  // independent statements of one packaging policy with no channel between
  // them, and by 2026-08-07 they disagreed on FOUR clauses — the shell gate
  // demanded a `.mcp.json` this suite's tree does not ship, demanded a
  // plugin.json `hooks` field line 21 asserts is undefined, demanded a
  // `SessionEnd` hook line 116 asserts is absent, and forbade the
  // `SessionStart` line 114 asserts is present. Nobody paid a cost, because the
  // gate was step 1 of an `&&` chain no workflow ran.
  //
  // .claude-plugin/packaging-policy.json is now the single statement, and these
  // cases assert that this suite's own expectations still agree with it. If a
  // future edit moves one and not the other, this is where it stops.
  describe('packaging policy agreement (task 064, DR-24)', () => {
    const policy = JSON.parse(
      readFileSync(join(repoRoot, '.claude-plugin', 'packaging-policy.json'), 'utf-8'),
    );

    it('PackagingPolicy_HookSet_AgreesWithThisSuite', () => {
      const expected = policy.hooks.expected.map((h: { type: string }) => h.type).sort();
      const retired = policy.hooks.retired.map((h: { type: string }) => h.type);
      // Mirrors hooksConfig_declaredHooks_areObserverOnly above, term for term.
      expect(expected).toEqual(['SessionStart', 'SubagentStop']);
      for (const t of ['PreToolUse', 'TaskCompleted', 'TeammateIdle', 'SubagentStart', 'PreCompact', 'SessionEnd']) {
        expect(retired, `${t} must stay recorded as retired`).toContain(t);
      }
      expect(policy.hooks.exact).toBe(true);
    });

    it('PackagingPolicy_ManifestFields_AgreeWithThisSuite', () => {
      const required = policy.manifest.requiredFields.map((f: { field: string }) => f.field);
      const forbidden = policy.manifest.forbiddenFields.map((f: { field: string }) => f.field);
      // Mirrors pluginManifest_requiredFields_containsAllFields above.
      for (const f of ['name', 'version', 'commands', 'skills', 'mcpServers']) {
        expect(required, `${f} must stay required`).toContain(f);
      }
      expect(forbidden, 'declaring `hooks` double-registers every hook').toContain('hooks');
      expect(policy.manifest.mcpServers.expected.map((s: { name: string }) => s.name)).toEqual(['exarchos']);
      expect(policy.manifest.mcpServers.exact).toBe(true);
    });

    it('PackagingPolicy_ForbidsTheStandaloneMcpJson_AndTheRepoHasNone', () => {
      const forbidden = policy.forbiddenFiles.map((f: { path: string }) => f.path);
      expect(forbidden).toContain('.mcp.json');
      // The claim and the tree, asserted together — a policy naming a file that
      // is already present would be a rule nobody could satisfy.
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
