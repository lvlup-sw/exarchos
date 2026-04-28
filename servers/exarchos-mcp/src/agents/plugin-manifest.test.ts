import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManifestSchema } from './plugin-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PluginManifestSchema', () => {
  it('PluginManifestSchema_AcceptsCanonicalShape', () => {
    const valid = {
      name: 'exarchos',
      description: 'Test description',
      version: '0.0.0',
      author: { name: 'Test Author' },
      homepage: 'https://example.com',
      repository: 'https://example.com/repo',
      license: 'Apache-2.0',
      keywords: ['workflow'],
      agents: ['./agents/implementer.md', './agents/reviewer.md'],
      commands: './commands/',
      skills: './skills/',
      mcpServers: {
        exarchos: {
          type: 'stdio',
          command: 'exarchos',
          args: ['mcp'],
          env: { FOO: 'bar' },
        },
      },
      metadata: { compat: { minBinaryVersion: '2.9.0-rc.1' } },
    };
    expect(() => PluginManifestSchema.parse(valid)).not.toThrow();
  });

  it('PluginManifestSchema_RejectsMissingAgents', () => {
    expect(() => PluginManifestSchema.parse({})).toThrow();
  });

  it('PluginManifestSchema_RejectsAgentEntryWithBadShape', () => {
    expect(() =>
      PluginManifestSchema.parse({
        name: 'exarchos',
        agents: ['not-a-relative-md-path'],
      }),
    ).toThrow();
  });

  it('PluginManifestSchema_AcceptsActualLivePluginJson', () => {
    // Read the actual .claude-plugin/plugin.json and assert it parses.
    // Regression guard against schema drift.
    // __dirname = servers/exarchos-mcp/src/agents → repoRoot is 4 levels up.
    const repoRoot = path.resolve(__dirname, '../../../..');
    const livePath = path.join(repoRoot, '.claude-plugin/plugin.json');
    const live = JSON.parse(fs.readFileSync(livePath, 'utf8')) as unknown;
    expect(() => PluginManifestSchema.parse(live)).not.toThrow();
  });
});
