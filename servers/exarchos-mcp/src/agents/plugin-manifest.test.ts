import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PluginManifestSchema,
  readPluginManifest,
  writePluginManifest,
  type PluginManifest,
} from './plugin-manifest.js';

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
    expect(caught!.message).toMatch(/position|line|column|JSON/i);
  });

  it('ReadPluginManifest_ThrowsDescriptive_OnSchemaViolation', () => {
    const file = makeTmpFile(JSON.stringify({ name: 'x' }));
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

describe('writePluginManifest', () => {
  const createdDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-plugin-manifest-'));
    createdDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir !== undefined) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  const validManifest: PluginManifest = {
    name: 'exarchos',
    description: 'Test description',
    version: '0.0.0',
    author: { name: 'Test Author' },
    agents: ['./agents/implementer.md', './agents/reviewer.md'],
    commands: './commands/',
    skills: './skills/',
    metadata: { compat: { minBinaryVersion: '2.9.0-rc.1' } },
  };

  it('WritePluginManifest_AtomicReplace_RoundTrips', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'plugin.json');
    writePluginManifest(target, validManifest);
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = PluginManifestSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual(validManifest);
  });

  it('WritePluginManifest_RejectsInvalidShape', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'plugin.json');
    const invalid = {
      name: 'exarchos',
      agents: ['not-a-valid-path'],
    } as unknown as PluginManifest;
    expect(() => writePluginManifest(target, invalid)).toThrow();
    expect(fs.existsSync(target)).toBe(false);
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('WritePluginManifest_PreservesOriginalOnRenameError', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'plugin.json');
    fs.mkdirSync(target);
    const dirInodeBefore = fs.statSync(target).ino;
    const dirIsDirBefore = fs.statSync(target).isDirectory();
    expect(() => writePluginManifest(target, validManifest)).toThrow();
    const statAfter = fs.statSync(target);
    expect(statAfter.isDirectory()).toBe(dirIsDirBefore);
    expect(statAfter.ino).toBe(dirInodeBefore);
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('WritePluginManifest_TempFileCreatedAndRemoved_OnSuccess', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'plugin.json');
    writePluginManifest(target, validManifest);
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['plugin.json']);
  });
});
