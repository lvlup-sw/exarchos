// The `plugin.json` manifest lists the rendered agent files, and `package.json` holds the
// `generate:agents` script.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const PLUGIN_JSON_PATH = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const AGENTS_DIR = path.join(REPO_ROOT, 'rendered/agents');

describe('Plugin Manifest', () => {
  /** Claude Code rejects a directory string such as `"agents": "./rendered/agents/"`. */
  it('PluginManifest_AgentsFieldIsArray_OfFilePaths', () => {
    const raw = fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8');
    const manifest = JSON.parse(raw);

    expect(manifest).toHaveProperty('agents');
    expect(Array.isArray(manifest.agents)).toBe(true);
    expect(manifest.agents.length).toBeGreaterThan(0);
    for (const entry of manifest.agents) {
      expect(typeof entry).toBe('string');
      expect(entry).toMatch(/^\.\/rendered\/agents\/.*\.md$/);
    }
  });

  it('PluginManifest_AgentsDirectoryExists_HasGitkeep', () => {
    expect(fs.existsSync(AGENTS_DIR)).toBe(true);
    expect(fs.statSync(AGENTS_DIR).isDirectory()).toBe(true);

    expect(fs.existsSync(path.join(AGENTS_DIR, '.gitkeep'))).toBe(true);
  });

  it('PluginManifest_GenerateAgentsScript_Exists', () => {
    const pkgPath = path.resolve(import.meta.dirname, '../../../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);

    expect(pkg.scripts).toHaveProperty('generate:agents');
  });
});
