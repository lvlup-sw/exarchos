import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  Manifest,
  CoreComponent,
  McpServerComponent,
  PluginComponent,
  RuleSetComponent,
  ManifestDefaults,
} from './types.js';
import {
  loadManifest,
  getDefaultSelections,
  getRequiredComponents,
} from './loader.js';
import type { WizardSelections } from './loader.js';

// ─── A1: Type definition tests ───────────────────────────────────────────────

/** A complete, valid manifest fixture used throughout the test suite. */
function createValidManifest(): Manifest {
  return {
    version: '1.0.0',
    components: {
      core: [
        {
          id: 'commands',
          source: 'commands',
          target: 'commands',
          type: 'directory',
        },
      ] satisfies CoreComponent[],
      mcpServers: [
        {
          id: 'exarchos',
          name: 'Exarchos',
          description: 'Workflow orchestration',
          required: true,
          type: 'bundled',
          bundlePath: 'plugins/exarchos',
        },
        {
          id: 'github',
          name: 'GitHub',
          description: 'GitHub integration',
          required: false,
          type: 'external',
          command: 'npx',
          args: ['-y', '@anthropic/github-mcp'],
          prerequisite: 'gh auth status',
        },
      ] satisfies McpServerComponent[],
      plugins: [
        {
          id: 'serena',
          name: 'Serena',
          description: 'Semantic code analysis',
          required: false,
          default: true,
        },
        {
          id: 'context7',
          name: 'Context7',
          description: 'Library docs',
          required: false,
          default: false,
        },
      ] satisfies PluginComponent[],
      ruleSets: [
        {
          id: 'typescript',
          name: 'TypeScript Standards',
          description: 'TS coding rules',
          files: ['coding-standards-typescript.md', 'tdd-typescript.md'],
          default: true,
        },
        {
          id: 'dotnet',
          name: '.NET Standards',
          description: '.NET coding rules',
          files: ['coding-standards-dotnet.md'],
          default: false,
        },
      ] satisfies RuleSetComponent[],
    },
    defaults: {
      model: 'claude-sonnet-4-20250514',
      mode: 'standard',
    } satisfies ManifestDefaults,
  };
}

describe('Manifest Type Definitions (A1)', () => {
  it('loadManifest_ValidManifest_ReturnsTypedObject', () => {
    const manifest = createValidManifest();

    // Verify top-level structure
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.components).toBeDefined();
    expect(manifest.defaults).toBeDefined();

    // Verify CoreComponent fields
    const core = manifest.components.core[0];
    expect(core.id).toBe('commands');
    expect(core.source).toBe('commands');
    expect(core.target).toBe('commands');
    expect(core.type).toBe('directory');

    // Verify McpServerComponent fields
    const bundled = manifest.components.mcpServers[0];
    expect(bundled.id).toBe('exarchos');
    expect(bundled.name).toBe('Exarchos');
    expect(bundled.required).toBe(true);
    expect(bundled.type).toBe('bundled');
    expect(bundled.bundlePath).toBe('plugins/exarchos');

    const external = manifest.components.mcpServers[1];
    expect(external.type).toBe('external');
    expect(external.command).toBe('npx');
    expect(external.args).toEqual(['-y', '@anthropic/github-mcp']);
    expect(external.prerequisite).toBe('gh auth status');

    // Verify PluginComponent fields
    const plugin = manifest.components.plugins[0];
    expect(plugin.id).toBe('serena');
    expect(plugin.required).toBe(false);
    expect(plugin.default).toBe(true);

    // Verify RuleSetComponent fields
    const ruleSet = manifest.components.ruleSets[0];
    expect(ruleSet.id).toBe('typescript');
    expect(ruleSet.files).toEqual([
      'coding-standards-typescript.md',
      'tdd-typescript.md',
    ]);
    expect(ruleSet.default).toBe(true);

    // Verify ManifestDefaults fields
    expect(manifest.defaults.model).toBe('claude-sonnet-4-20250514');
    expect(manifest.defaults.mode).toBe('standard');
  });
});

// ─── A2: Manifest Loader tests ──────────────────────────────────────────────

describe('Manifest Loader (A2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write a manifest JSON file and return its path. */
  function writeManifestFile(data: unknown, filename = 'manifest.json'): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }

  describe('loadManifest', () => {
    it('loadManifest_ValidFile_ReturnsManifest', () => {
      const manifestData = createValidManifest();
      const filePath = writeManifestFile(manifestData);

      const result = loadManifest(filePath);

      expect(result.version).toBe('1.0.0');
      expect(result.components.core).toHaveLength(1);
      expect(result.components.mcpServers).toHaveLength(2);
      expect(result.components.plugins).toHaveLength(2);
      expect(result.components.ruleSets).toHaveLength(2);
      expect(result.defaults.model).toBe('claude-sonnet-4-20250514');
      expect(result.defaults.mode).toBe('standard');
    });

    it('loadManifest_MissingFile_ThrowsError', () => {
      const badPath = path.join(tmpDir, 'nonexistent.json');

      expect(() => loadManifest(badPath)).toThrow(/not found|ENOENT/i);
    });

    it('loadManifest_InvalidJson_ThrowsError', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, '{ not valid json !!!', 'utf-8');

      expect(() => loadManifest(filePath)).toThrow(/parse|JSON/i);
    });

    it('loadManifest_MissingRequiredField_ThrowsError', () => {
      // Missing 'version' field
      const incomplete = {
        components: {
          core: [],
          mcpServers: [],
          plugins: [],
          ruleSets: [],
        },
        defaults: { model: 'test', mode: 'standard' },
      };
      const filePath = writeManifestFile(incomplete);

      expect(() => loadManifest(filePath)).toThrow(/version/i);
    });

    it('loadManifest_MissingComponentsField_ThrowsError', () => {
      const incomplete = {
        version: '1.0.0',
        defaults: { model: 'test', mode: 'standard' },
      };
      const filePath = writeManifestFile(incomplete);

      expect(() => loadManifest(filePath)).toThrow(/components/i);
    });

    it('loadManifest_MissingDefaultsField_ThrowsError', () => {
      const incomplete = {
        version: '1.0.0',
        components: {
          core: [],
          mcpServers: [],
          plugins: [],
          ruleSets: [],
        },
      };
      const filePath = writeManifestFile(incomplete);

      expect(() => loadManifest(filePath)).toThrow(/defaults/i);
    });
  });

  describe('getDefaultSelections', () => {
    it('getDefaultSelections_Manifest_ReturnsDefaults', () => {
      const manifest = createValidManifest();

      const selections = getDefaultSelections(manifest);

      // 'serena' plugin has default: true; 'context7' has default: false
      expect(selections.plugins).toEqual(['serena']);
      // 'typescript' ruleset has default: true; 'dotnet' has default: false
      expect(selections.ruleSets).toEqual(['typescript']);
      // mcpServers with required: true should NOT be in selections
      // (they're always installed); only optional servers with default behavior
      // For now, no optional servers have a default flag, so empty
      expect(selections.mcpServers).toEqual([]);
      // model from defaults
      expect(selections.model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('getRequiredComponents', () => {
    it('getRequiredComponents_Manifest_ReturnsRequired', () => {
      const manifest = createValidManifest();

      const required = getRequiredComponents(manifest);

      // 'exarchos' server is required: true; 'github' is required: false
      expect(required.servers).toEqual(['exarchos']);
      // No plugins have required: true in our fixture
      expect(required.plugins).toEqual([]);
    });
  });
});

// ─── E5: Real manifest.json tests ────────────────────────────────────────────

describe('Real Manifest File (E5)', () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const manifestPath = path.join(repoRoot, 'manifest.json');
  const pkgPath = path.join(repoRoot, 'package.json');

  it('manifest_Exists_IsValidJson', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('manifest_ContainsAllCoreComponents', () => {
    const manifest = loadManifest(manifestPath);
    const coreIds = manifest.components.core.map((c) => c.id);
    expect(coreIds).toContain('commands');
    expect(coreIds).toContain('skills');
    expect(coreIds).toContain('scripts');
  });

  it('manifest_ContainsRequiredServers', () => {
    const manifest = loadManifest(manifestPath);
    const required = getRequiredComponents(manifest);
    expect(required.servers).toContain('exarchos');
    expect(required.servers).toContain('graphite');
  });

  it('manifest_ContainsAllPlugins', () => {
    const manifest = loadManifest(manifestPath);
    const pluginIds = manifest.components.plugins.map((p) => p.id);
    expect(pluginIds).toContain('github@claude-plugins-official');
    expect(pluginIds).toContain('serena@claude-plugins-official');
    expect(pluginIds).toContain('context7@claude-plugins-official');
  });

  it('manifest_ContainsAllRuleSets', () => {
    const manifest = loadManifest(manifestPath);
    const ruleSetIds = manifest.components.ruleSets.map((r) => r.id);
    expect(ruleSetIds).toContain('typescript');
    expect(ruleSetIds).toContain('csharp');
    expect(ruleSetIds).toContain('workflow');
  });

  it('manifest_RuleSetFiles_AllExist', () => {
    const manifest = loadManifest(manifestPath);
    const rulesDir = path.join(repoRoot, 'rules');

    for (const ruleSet of manifest.components.ruleSets) {
      for (const file of ruleSet.files) {
        const filePath = path.join(rulesDir, file);
        expect(fs.existsSync(filePath), `Rule file missing: ${file} (in ruleSet '${ruleSet.id}')`).toBe(true);
      }
    }
  });

  it('manifest_Version_MatchesPackageJson', () => {
    const manifest = loadManifest(manifestPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(manifest.version).toBe(pkg.version);
  });
});
