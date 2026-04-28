import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PluginManifestSchema,
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
    // Read the actual .claude-plugin/plugin.json and assert it parses.
    // Regression guard against schema drift.
    // __dirname = servers/exarchos-mcp/src/agents → repoRoot is 4 levels up.
    const repoRoot = path.resolve(__dirname, '../../../..');
    const livePath = path.join(repoRoot, '.claude-plugin/plugin.json');
    const live = JSON.parse(fs.readFileSync(livePath, 'utf8')) as unknown;
    expect(() => PluginManifestSchema.parse(live)).not.toThrow();
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

    // Round-trip: parse the file back through the same schema and assert
    // deep-equal. Mirrors what readPluginManifest (T14) will do.
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = PluginManifestSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual(validManifest);
  });

  it('WritePluginManifest_RejectsInvalidShape', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'plugin.json');

    const invalid = {
      name: 'exarchos',
      // Violates AgentPathSchema — must match `./agents/<kebab>.md`.
      agents: ['not-a-valid-path'],
    } as unknown as PluginManifest;

    expect(() => writePluginManifest(target, invalid)).toThrow();

    // The schema must reject BEFORE any disk I/O — neither the target
    // nor a temp sibling should exist.
    expect(fs.existsSync(target)).toBe(false);
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('WritePluginManifest_PreservesOriginalOnRenameError', () => {
    const dir = makeTmpDir();
    // Use a DIRECTORY at the target path — `fs.renameSync(file, existingDir)`
    // fails predictably (EISDIR on Linux, ENOTDIR on macOS) and the failure
    // happens AFTER the temp file is staged. That's the exact error path we
    // want to exercise: temp written, rename throws, original (the dir) is
    // untouched, and the temp must be cleaned up.
    //
    // Mocking `fs.renameSync` directly is not viable here — vitest cannot
    // spy on ESM namespace exports (`Cannot redefine property: renameSync`),
    // and `vi.mock('node:fs', …)` would clobber every other fs call in the
    // module. A real failure path is both more portable and a stronger
    // assertion.
    const target = path.join(dir, 'plugin.json');
    fs.mkdirSync(target);
    const dirInodeBefore = fs.statSync(target).ino;
    const dirIsDirBefore = fs.statSync(target).isDirectory();

    expect(() => writePluginManifest(target, validManifest)).toThrow();

    // Original (the directory) is untouched: still a directory, same inode.
    const statAfter = fs.statSync(target);
    expect(statAfter.isDirectory()).toBe(dirIsDirBefore);
    expect(statAfter.ino).toBe(dirInodeBefore);

    // No temp leftover next to the target.
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('WritePluginManifest_TempFileCreatedAndRemoved_OnSuccess', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'plugin.json');

    writePluginManifest(target, validManifest);

    // Only the target file should remain — no `*.tmp.*` siblings.
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['plugin.json']);
  });
});
