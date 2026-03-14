// ─── Plugin Manifest Tests ──────────────────────────────────────────────────
//
// Verifies the plugin.json manifest includes the agents directory reference,
// and that the generate:agents script is configured.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Resolve plugin root relative to this file ────────────────────────────

// This file is at servers/exarchos-mcp/src/agents/plugin.test.ts
// Plugin root is at ../../.claude-plugin/ (relative to repo root)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../');
const PLUGIN_JSON_PATH = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

// ─── Task 7: Plugin Manifest ─────────────────────────────────────────────

describe('Plugin Manifest', () => {
  it('PluginManifest_AgentsFieldIsArray_OfFilePaths', () => {
    // Arrange: read plugin.json
    const raw = fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8');
    const manifest = JSON.parse(raw);

    // Assert: agents field is an array of file paths (not a directory string —
    // Claude Code rejects "agents": "./agents/" with validation error)
    expect(manifest).toHaveProperty('agents');
    expect(Array.isArray(manifest.agents)).toBe(true);
    expect(manifest.agents.length).toBeGreaterThan(0);
    for (const entry of manifest.agents) {
      expect(typeof entry).toBe('string');
      expect(entry).toMatch(/^\.\/agents\/.*\.md$/);
    }
  });

  it('PluginManifest_AgentsDirectoryExists_HasGitkeep', () => {
    // Assert: agents/ directory exists
    expect(fs.existsSync(AGENTS_DIR)).toBe(true);
    expect(fs.statSync(AGENTS_DIR).isDirectory()).toBe(true);

    // Assert: .gitkeep exists
    expect(fs.existsSync(path.join(AGENTS_DIR, '.gitkeep'))).toBe(true);
  });

  it('PluginManifest_GenerateAgentsScript_Exists', () => {
    // Arrange: read servers/exarchos-mcp/package.json
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);

    // Assert: generate:agents script exists
    expect(pkg.scripts).toHaveProperty('generate:agents');
  });
});
