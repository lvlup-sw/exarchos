import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManifestSchema, readPluginManifest } from './plugin-manifest.js';

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

describe('readPluginManifest', () => {
  const tmpDirs: string[] = [];

  function makeTmpFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manifest-test-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'plugin.json');
    fs.writeFileSync(file, contents, 'utf8');
    return file;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir !== undefined) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('ReadPluginManifest_ParsesValidFile', () => {
    const valid = {
      name: 'exarchos',
      description: 'Test',
      version: '0.0.0',
      agents: ['./agents/implementer.md', './agents/reviewer.md'],
      metadata: { compat: { minBinaryVersion: '2.9.0-rc.1' } },
    };
    const file = makeTmpFile(JSON.stringify(valid));
    const result = readPluginManifest(file);
    expect(result.name).toBe('exarchos');
    expect(result.agents).toEqual(['./agents/implementer.md', './agents/reviewer.md']);
    expect(result.version).toBe('0.0.0');
  });

  it('ReadPluginManifest_ThrowsDescriptive_OnMissingFile', () => {
    const missing = path.join(os.tmpdir(), 'definitely-does-not-exist-xyz', 'plugin.json');
    expect(() => readPluginManifest(missing)).toThrow(missing);
  });

  it('ReadPluginManifest_ThrowsDescriptive_OnInvalidJson', () => {
    const file = makeTmpFile('{not json}');
    let caught: Error | undefined;
    try {
      readPluginManifest(file);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain(file);
    // Parse-position info from JSON.parse (e.g., "position N" or "line/column")
    expect(caught!.message).toMatch(/position|line|column|JSON/i);
  });

  it('ReadPluginManifest_ThrowsDescriptive_OnSchemaViolation', () => {
    const file = makeTmpFile(JSON.stringify({ name: 'x' })); // missing `agents`
    let caught: Error | undefined;
    try {
      readPluginManifest(file);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain(file);
    expect(caught!.message).toContain('schema violation');
    expect(caught!.message).toContain('agents');
  });
});
