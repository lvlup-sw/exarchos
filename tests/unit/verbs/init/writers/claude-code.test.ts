/**
 * Tests for the Claude Code writer. The MCP cases compare the entry with the shipped plugin manifest and with values written by hand.
 *
 * @oracle-sources: ../../../../../.claude-plugin/plugin.json, the config files and entries written by hand in each case
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { claudeCodeWriter, writeClaudeCode, ClaudeCodeWriter, type OnrampSeam } from '../../../../../src/verbs/init/writers/claude-code.js';
import { atomicWriteJson } from '../../../../../src/verbs/init/writers/claude-code.js';
import { makeStubWriterDeps } from '../../../../../src/verbs/init/probes.js';
import type { WriterFs } from '../../../../../src/verbs/init/probes.js';
import type { WriteOptions } from '../../../../../src/verbs/init/writers/writer.js';

/** In-memory filesystem for testing. It records writes and renames. A path is a directory when `mkdir` created it or a stored file is under it. */
function makeMemFs(files: Record<string, string> = {}): WriterFs & {
  readonly written: Record<string, string>;
  readonly renames: Array<{ from: string; to: string }>;
  readonly mkdirs: string[];
  readonly copies: Array<{ src: string; dest: string }>;
} {
  const store: Record<string, string> = { ...files };
  const written: Record<string, string> = {};
  const renames: Array<{ from: string; to: string }> = [];
  const mkdirs: string[] = [];
  const copies: Array<{ src: string; dest: string }> = [];
  const dirs = new Set<string>();

  return {
    written,
    renames,
    mkdirs,
    copies,
    readFile: async (p: string) => {
      if (p in store) return store[p];
      const err = new Error(`ENOENT: ${p}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    },
    writeFile: async (p: string, content: string) => {
      store[p] = content;
      written[p] = content;
    },
    mkdir: async (p: string, _opts?: { recursive?: boolean }) => {
      mkdirs.push(p);
      dirs.add(p);
    },
    stat: async (p: string) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const isImplicitDir = dirs.has(p) || Object.keys(store).some((k) => k.startsWith(prefix));
      if (p in store || isImplicitDir) {
        return {
          isDirectory: () => isImplicitDir,
          isFile: () => p in store,
        };
      }
      const err = new Error(`ENOENT: ${p}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    },
    rename: async (oldPath: string, newPath: string) => {
      renames.push({ from: oldPath, to: newPath });
      if (oldPath in store) {
        store[newPath] = store[oldPath];
        delete store[oldPath];
      }
    },
    copyFile: async (src: string, dest: string) => {
      copies.push({ src, dest });
      if (src in store) {
        store[dest] = store[src];
      }
    },
    readdir: async (p: string) => {
      const entries: string[] = [];
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split('/')[0];
          if (segment && !entries.includes(segment)) {
            entries.push(segment);
          }
        }
      }
      return entries;
    },
  };
}

function defaultOptions(overrides?: Partial<WriteOptions>): WriteOptions {
  return {
    projectRoot: '/project',
    nonInteractive: false,
    forceOverwrite: false,
    ...overrides,
  };
}

/** The plugin manifest of this repository. Its `mcpServers.exarchos` entry is the one registration that the writer must copy. */
const PLUGIN_MANIFEST = path.resolve(import.meta.dirname, '../../../../../.claude-plugin/plugin.json');

/** The entry that the writer must put in `/home/user/.claude.json`. */
const EXPECTED_ENTRY = {
  type: 'stdio',
  command: 'exarchos',
  args: ['mcp'],
  env: { WORKFLOW_STATE_DIR: '/home/user/.claude/workflow-state' },
};

/** Parses the JSON that the writer staged at `p`. The test fails when the writer staged nothing there. */
function stagedJson(written: Readonly<Record<string, string>>, p: string): unknown {
  const raw = written[p];
  if (raw === undefined) throw new Error(`nothing staged at ${p}`);
  return JSON.parse(raw);
}

/** The `mcpServers.exarchos` value of a parsed config, or `undefined` when the config has none. */
function exarchosEntryOf(config: unknown): unknown {
  if (typeof config !== 'object' || config === null || !('mcpServers' in config)) return undefined;
  const servers = config.mcpServers;
  if (typeof servers !== 'object' || servers === null || !('exarchos' in servers)) return undefined;
  return servers.exarchos;
}

/** The `command` and `args` of an MCP server entry. A value that is not an object gives two `undefined` fields. */
function commandAndArgs(entry: unknown): { command: unknown; args: unknown } {
  if (typeof entry !== 'object' || entry === null) return { command: undefined, args: undefined };
  return {
    command: 'command' in entry ? entry.command : undefined,
    args: 'args' in entry ? entry.args : undefined,
  };
}

/**
 * The files of an installed `exarchos` plugin under `/home/user`, with a manifest that declares `mcpServers`.
 * `record` replaces the scope fields of the `installed_plugins.json` record. The default is a `user` install.
 */
function pluginFiles(
  mcpServers: Record<string, unknown>,
  record: Record<string, unknown> = { scope: 'user' },
): Record<string, string> {
  const installPath = '/home/user/.claude/plugins/cache/lvlup-sw/exarchos/2.12.1';
  return {
    '/home/user/.claude/plugins/installed_plugins.json': JSON.stringify({
      version: 2,
      plugins: {
        'exarchos@lvlup-sw': [{ ...record, installPath, version: '2.12.1' }],
      },
    }),
    [`${installPath}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'exarchos', mcpServers }),
  };
}

/** A settings file at `p` whose `enabledPlugins` gives `value` for the `exarchos@lvlup-sw` plugin. */
function pluginSetting(p: string, value: unknown): Record<string, string> {
  return { [p]: JSON.stringify({ enabledPlugins: { 'exarchos@lvlup-sw': value } }) };
}

/** The user settings file that turns on the `exarchos@lvlup-sw` plugin. */
const ENABLED_IN_USER_SETTINGS = pluginSetting('/home/user/.claude/settings.json', true);

describe('atomicWriteJson', () => {
  it('AtomicWriteJson_WritesToTmpThenRenames', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({ fs });

    await atomicWriteJson(deps, '/config/test.json', { hello: 'world' });

    expect(fs.written['/config/test.json.tmp']).toBe(
      JSON.stringify({ hello: 'world' }, null, 2),
    );
    expect(fs.renames).toEqual([
      { from: '/config/test.json.tmp', to: '/config/test.json' },
    ]);
  });

  it('AtomicWriteJson_ProducesValidJson', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({ fs });

    await atomicWriteJson(deps, '/out.json', { a: 1, b: [2, 3] });

    const parsed = JSON.parse(fs.written['/out.json.tmp']);
    expect(parsed).toEqual({ a: 1, b: [2, 3] });
  });
});

describe('claudeCodeWriter', () => {
  it('ClaudeCodeWriter_RuntimeIsClaudeCode', () => {
    expect(claudeCodeWriter.runtime).toBe('claude-code');
  });

  it('ClaudeCodeWriter_NoExistingConfig_CreatesNewWithExarchosMcp', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.runtime).toBe('claude-code');
    expect(result.path).toBe('/home/user/.claude.json');
    expect(result.componentsWritten).toContain('mcp-config');

    const tmpPath = '/home/user/.claude.json.tmp';
    const content = JSON.parse(fs.written[tmpPath]);
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers.exarchos).toBeDefined();
    expect(content.mcpServers.exarchos.type).toBe('stdio');
  });

  it('ClaudeCodeWriter_ExistingConfigWithOtherServers_PreservesExisting', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        'my-other-server': {
          type: 'stdio',
          command: 'node',
          args: ['other.js'],
        },
      },
      someOtherKey: 'preserved',
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');

    const tmpPath = '/home/user/.claude.json.tmp';
    const content = JSON.parse(fs.written[tmpPath]);
    expect(content.mcpServers['my-other-server']).toBeDefined();
    expect(content.mcpServers.exarchos).toBeDefined();
    expect(content.someOtherKey).toBe('preserved');
  });

  it('ClaudeCodeWriter_ExistingExarchosEntry_OverwritesWhenForced', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        exarchos: {
          type: 'stdio',
          command: 'node',
          args: ['old-path.js'],
        },
      },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(
      deps,
      defaultOptions({ forceOverwrite: true }),
    );

    expect(result.status).toBe('written');
    const tmpPath = '/home/user/.claude.json.tmp';
    const content = JSON.parse(fs.written[tmpPath]);
    expect(content.mcpServers.exarchos).toBeDefined();
  });

  it('ClaudeCodeWriter_ExistingExarchosEntry_SkipsWhenNotForced', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        exarchos: {
          type: 'stdio',
          command: 'node',
          args: ['old-path.js'],
        },
      },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('skipped');
    expect(result.componentsWritten).not.toContain('mcp-config');
  });

  it('ClaudeCodeWriter_InvalidExistingJson_ReturnsFailedResult', async () => {
    const fs = makeMemFs({
      '/home/user/.claude.json': '{ not valid json !!!',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('ClaudeCodeWriter_AtomicWrite_UsesTmpAndRename', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    await claudeCodeWriter.write(deps, defaultOptions());

    expect(fs.renames.some(
      (r) =>
        r.from === '/home/user/.claude.json.tmp' &&
        r.to === '/home/user/.claude.json',
    )).toBe(true);
  });

  it('ClaudeCodeWriter_McpServerEntry_HasCorrectShape', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    await claudeCodeWriter.write(deps, defaultOptions());

    const tmpPath = '/home/user/.claude.json.tmp';
    const content = JSON.parse(fs.written[tmpPath]);
    const entry = content.mcpServers.exarchos;
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBeDefined();
    expect(entry.args).toBeDefined();
    expect(Array.isArray(entry.args)).toBe(true);
  });

  /**
   * The user-scope entry and the plugin manifest start the same server.
   * The test reads the shipped manifest, so the two registrations cannot drift apart.
   */
  it('ClaudeCodeWriter_McpServerEntry_MatchesThePluginRegistration', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    await claudeCodeWriter.write(deps, defaultOptions());

    const pluginEntry = exarchosEntryOf(JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8')));
    const entry = exarchosEntryOf(stagedJson(fs.written, '/home/user/.claude.json.tmp'));
    expect(commandAndArgs(entry)).toEqual(commandAndArgs(pluginEntry));
    expect(entry).toEqual(EXPECTED_ENTRY);
  });

  /** No install step puts a file under `~/.claude/mcp-servers/`, so an entry that names that directory starts nothing. */
  it('ClaudeCodeWriter_McpServerEntry_NamesNoMcpServersBundle', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    await claudeCodeWriter.write(deps, defaultOptions());

    const entry = exarchosEntryOf(stagedJson(fs.written, '/home/user/.claude.json.tmp'));
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('mcp-servers');
  });

  /**
   * An older writer pointed the entry at `~/.claude/mcp-servers/exarchos-mcp.js`, which nothing installs.
   * The writer replaces that entry without `forceOverwrite`, and it keeps the other servers.
   */
  it('ClaudeCodeWriter_StaleBundleEntry_IsRewrittenWithoutForce', async () => {
    const other = { type: 'stdio', command: 'node', args: ['other.js'] };
    const existingConfig = JSON.stringify({
      mcpServers: {
        exarchos: {
          type: 'stdio',
          command: 'node',
          args: ['/home/user/.claude/mcp-servers/exarchos-mcp.js'],
          env: { WORKFLOW_STATE_DIR: '/home/user/.claude/workflow-state' },
        },
        other,
      },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('mcp-config');
    const content = stagedJson(fs.written, '/home/user/.claude.json.tmp');
    expect(exarchosEntryOf(content)).toEqual(EXPECTED_ENTRY);
    expect(content).toMatchObject({ mcpServers: { other } });
  });

  /**
   * The repair matches the bundle directory only.
   * A `node` entry in a sibling directory is a hand edit, so the writer keeps it without `forceOverwrite`.
   */
  it('ClaudeCodeWriter_NodeEntryOutsideTheBundleDir_IsKeptWithoutForce', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        exarchos: {
          type: 'stdio',
          command: 'node',
          args: ['/home/user/.claude/mcp-servers-dev/exarchos-mcp.js'],
        },
      },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('skipped');
    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
  });

  /**
   * The repair matches the `node` command only.
   * An entry with another command and a first argument in the bundle directory is a hand edit, so the writer keeps it without `forceOverwrite`.
   */
  it('ClaudeCodeWriter_NonNodeEntryInTheBundleDir_IsKeptWithoutForce', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        exarchos: {
          type: 'stdio',
          command: 'bun',
          args: ['/home/user/.claude/mcp-servers/exarchos-mcp.js'],
        },
      },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('skipped');
    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
  });

  /**
   * The older installer wrote only `exarchos-mcp.js` in the bundle directory.
   * A `node` entry that starts another file there is a hand edit, so the writer keeps it without `forceOverwrite`.
   */
  it('ClaudeCodeWriter_NodeEntryForAnotherFileInTheBundleDir_IsKeptWithoutForce', async () => {
    const fs = makeMemFs({
      '/home/user/.claude.json': JSON.stringify({
        mcpServers: {
          exarchos: { type: 'stdio', command: 'node', args: ['/home/user/.claude/mcp-servers/my-exarchos.js'] },
        },
      }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('skipped');
    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
  });

  /** A `node` entry with no string first argument names no bundle file. It is a hand edit, so the writer keeps it without `forceOverwrite`. */
  it('ClaudeCodeWriter_NodeEntryWithNoStringFirstArgument_IsKeptWithoutForce', async () => {
    const fs = makeMemFs({
      '/home/user/.claude.json': JSON.stringify({
        mcpServers: { exarchos: { type: 'stdio', command: 'node', args: [] } },
      }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('skipped');
    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
  });

  it('ClaudeCodeWriter_WithCommandsInProject_CopiesCommandsToClaudeHome', async () => {
    const fs = makeMemFs({
      '/project/commands/workflow.md': '# Workflow command',
      '/project/commands/review.md': '# Review command',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('commands');
    expect(fs.copies.some((c) => c.dest.includes('.claude/commands/'))).toBe(true);
  });

  it('ClaudeCodeWriter_WithSkillsInProject_CopiesSkillsToClaudeHome', async () => {
    const fs = makeMemFs({
      '/project/skills/claude-code/workflow/SKILL.md': '# Workflow skill',
      '/project/skills/claude-code/review/SKILL.md': '# Review skill',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('skills');
    expect(fs.copies.some((c) => c.dest.includes('.claude/skills/'))).toBe(true);
  });

  it('ClaudeCodeWriter_FullDeploy_ReturnsAllThreeComponents', async () => {
    const fs = makeMemFs({
      '/project/commands/init.md': '# Init',
      '/project/skills/claude-code/init/SKILL.md': '# Init skill',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('mcp-config');
    expect(result.componentsWritten).toContain('commands');
    expect(result.componentsWritten).toContain('skills');
  });

  it('ClaudeCodeWriter_NoCommandsOrSkillsDirs_WritesMcpOnly', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toEqual(['mcp-config']);
  });

  it('ClaudeCodeWriter_CommandsCopied_CreatesTargetDirectory', async () => {
    const fs = makeMemFs({
      '/project/commands/help.md': '# Help',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    await claudeCodeWriter.write(deps, defaultOptions());

    expect(fs.mkdirs).toContain('/home/user/.claude/commands');
  });

  it('ClaudeCodeWriter_SkillsCopied_CreatesTargetDirectory', async () => {
    const fs = makeMemFs({
      '/project/skills/claude-code/test/SKILL.md': '# Test',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    await claudeCodeWriter.write(deps, defaultOptions());

    expect(fs.mkdirs).toContain('/home/user/.claude/skills');
  });

  it('ClaudeCodeWriter_SkippedMcpButHasContent_StillDeploysContent', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: { exarchos: { type: 'stdio', command: 'node', args: ['old.js'] } },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
      '/project/commands/workflow.md': '# Workflow',
      '/project/skills/claude-code/workflow/SKILL.md': '# Skill',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).not.toContain('mcp-config');
    expect(result.componentsWritten).toContain('commands');
    expect(result.componentsWritten).toContain('skills');
  });

  it('ClaudeCodeWriter_NothingToDo_ReturnsSkipped', async () => {
    const existingConfig = JSON.stringify({
      mcpServers: { exarchos: { type: 'stdio', command: 'node', args: ['old.js'] } },
    });
    const fs = makeMemFs({
      '/home/user/.claude.json': existingConfig,
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('skipped');
    expect(result.componentsWritten).toEqual([]);
  });

  /** The default seam does nothing for an absent project root, so the in-memory tests never touch the disk for the on-ramp phase. */
  it('ClaudeCodeWriter_NonexistentProjectRoot_SkipsOnramp', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.componentsWritten).not.toContain('onramp');
  });
});

describe('claudeCodeWriter on-ramp phase (DR-5)', () => {
  it('ClaudeCodeWriter_OnrampWrote_AddsOnrampComponent', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });
    const onramp: OnrampSeam = () => ({ wrote: true, failed: false, warnings: [] });

    const result = await writeClaudeCode(deps, defaultOptions(), onramp);

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('onramp');
    expect(result.onrampFailed).toBeUndefined();
  });

  /**
   * A failed AGENTS.md on-ramp write does not change the overall status, which stays `written`.
   * The result must set `onrampFailed`, so the onboard reconcile gate keeps the retired hooks in place.
   */
  it('ClaudeCodeWriter_OnrampFailed_SurfacesOnrampFailedButStaysWritten', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });
    const onramp: OnrampSeam = () => ({
      wrote: false,
      failed: true,
      warnings: ['Failed to write the Exarchos managed block to /project/AGENTS.md.'],
    });

    const result = await writeClaudeCode(deps, defaultOptions(), onramp);

    expect(result.status).toBe('written');
    expect(result.componentsWritten).not.toContain('onramp');
    expect(result.onrampFailed).toBe(true);
  });

  it('ClaudeCodeWriter_OnrampWarnings_SurfaceInResult', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });
    const onramp: OnrampSeam = () => ({
      wrote: true,
      failed: false,
      warnings: ['AGENTS.md is near the Codex 32 KiB cap'],
    });

    const result = await writeClaudeCode(deps, defaultOptions(), onramp);

    expect(result.warnings?.some((w) => /Codex/.test(w))).toBe(true);
  });

  it('ClaudeCodeWriter_ClassSeamInjection_ThreadsThrough', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });
    const writer = new ClaudeCodeWriter(() => ({ wrote: true, failed: false, warnings: [] }));

    const result = await writer.write(deps, defaultOptions());

    expect(result.componentsWritten).toContain('onramp');
  });
});

describe('claudeCodeWriter with the exarchos plugin installed', () => {
  /**
   * The plugin manifest already starts the server, so a user-scope entry is a second `exarchos` server.
   * The writer does not touch `~/.claude.json`, and the content phases still run.
   */
  it('ClaudeCodeWriter_PluginWiresExarchos_SkipsMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
      '/project/commands/workflow.md': '# Workflow',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
    expect(fs.written['/home/user/.claude.json']).toBeUndefined();
    expect(result.componentsWritten).not.toContain('mcp-config');
    expect(result.componentsWritten).toContain('commands');
    expect(result.warnings?.some((w) => w.includes('registered by the exarchos plugin'))).toBe(true);
  });

  /** `forceOverwrite` replaces a hand-edited entry. It does not add a second server next to the plugin server. */
  it('ClaudeCodeWriter_PluginWiresExarchosAndForceOverwrite_StillSkipsMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions({ forceOverwrite: true }));

    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
    expect(result.componentsWritten).not.toContain('mcp-config');
    expect(result.warnings?.some((w) => w.includes('registered by the exarchos plugin'))).toBe(true);
  });

  /** A `project` install serves only its own `projectPath`. In another project the writer still writes the user-scope entry. */
  it('ClaudeCodeWriter_ProjectScopePluginForAnotherProject_WritesMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles(
        { exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } },
        { scope: 'project', projectPath: '/other-project' },
      ),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.componentsWritten).toContain('mcp-config');
    expect(exarchosEntryOf(stagedJson(fs.written, '/home/user/.claude.json.tmp'))).toEqual(EXPECTED_ENTRY);
  });

  /** A `project` install whose `projectPath` is this project serves it, so the writer skips the MCP phase. */
  it('ClaudeCodeWriter_ProjectScopePluginForThisProject_SkipsMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles(
        { exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } },
        { scope: 'project', projectPath: '/project' },
      ),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes('registered by the exarchos plugin'))).toBe(true);
  });

  /**
   * The user settings turn the plugin on, but the local settings have a higher precedence and turn it off.
   * Claude Code then starts no plugin server, so the writer writes the user-scope entry.
   */
  it('ClaudeCodeWriter_PluginTurnedOffInAHigherPrecedenceFile_WritesMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...ENABLED_IN_USER_SETTINGS,
      ...pluginSetting('/project/.claude/settings.local.json', false),
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.componentsWritten).toContain('mcp-config');
    expect(exarchosEntryOf(stagedJson(fs.written, '/home/user/.claude.json.tmp'))).toEqual(EXPECTED_ENTRY);
  });

  /** A plugin manifest that declares no `exarchos` server does not start it, so the writer still writes the entry. */
  it('ClaudeCodeWriter_PluginWithoutExarchosServer_WritesMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles({}),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.componentsWritten).toContain('mcp-config');
    const content = stagedJson(fs.written, '/home/user/.claude.json.tmp');
    expect(exarchosEntryOf(content)).toEqual(EXPECTED_ENTRY);
    expect(content).toMatchObject({ numStartups: 3 });
  });

  /**
   * Claude Code loads a marketplace plugin only when a settings file turns it on.
   * An install record that no settings file names starts no server, so the writer writes the user-scope entry.
   */
  it('ClaudeCodeWriter_PluginThatNoSettingsFileNames_WritesMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.componentsWritten).toContain('mcp-config');
    expect(exarchosEntryOf(stagedJson(fs.written, '/home/user/.claude.json.tmp'))).toEqual(EXPECTED_ENTRY);
  });

  /** The project settings have a higher precedence than the user settings. When they turn the plugin on, the writer skips the MCP phase. */
  it('ClaudeCodeWriter_PluginTurnedOnInProjectSettings_SkipsMcpConfig', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...pluginSetting('/home/user/.claude/settings.json', false),
      ...pluginSetting('/project/.claude/settings.json', true),
      '/home/user/.claude.json': JSON.stringify({ numStartups: 3 }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
    expect(result.componentsWritten).not.toContain('mcp-config');
    expect(result.warnings?.some((w) => w.includes('registered by the exarchos plugin'))).toBe(true);
  });

  /**
   * An older writer left the stale bundle entry next to the plugin server, and Claude Code starts both.
   * Exarchos wrote that entry and it never works, so the writer removes it. It keeps the other servers and adds no entry.
   */
  it('ClaudeCodeWriter_PluginServesAndStaleBundleEntry_RemovesTheStaleEntry', async () => {
    const other = { type: 'stdio', command: 'node', args: ['other.js'] };
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({
        numStartups: 3,
        mcpServers: {
          exarchos: { type: 'stdio', command: 'node', args: ['/home/user/.claude/mcp-servers/exarchos-mcp.js'] },
          other,
        },
      }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.componentsWritten).toContain('mcp-config');
    expect(result.warnings?.some((w) => w.includes('removed the stale exarchos entry'))).toBe(true);
    const content = stagedJson(fs.written, '/home/user/.claude.json.tmp');
    expect(content).toEqual({ numStartups: 3, mcpServers: { other } });
  });

  /** An entry that is not the stale bundle entry is a hand edit. When the plugin serves the project, the writer keeps that entry, also with `forceOverwrite`. */
  it('ClaudeCodeWriter_PluginServesAndHandEditedEntry_KeepsTheEntry', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': JSON.stringify({
        mcpServers: { exarchos: { type: 'stdio', command: 'node', args: ['/opt/exarchos/dist/exarchos.js', 'mcp'] } },
      }),
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions({ forceOverwrite: true }));

    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
    expect(result.componentsWritten).not.toContain('mcp-config');
    expect(result.warnings?.some((w) => w.includes('registered by the exarchos plugin'))).toBe(true);
  });

  /** The plugin starts the server, so a config that the writer cannot parse is not a failure. The writer leaves it unchanged and runs the content phases. */
  it('ClaudeCodeWriter_PluginServesAndConfigIsMalformed_SkipsMcpConfigWithoutAFailure', async () => {
    const fs = makeMemFs({
      ...pluginFiles({ exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } }),
      ...ENABLED_IN_USER_SETTINGS,
      '/home/user/.claude.json': '{ not valid json',
      '/project/commands/workflow.md': '# Workflow',
    });
    const deps = makeStubWriterDeps({
      fs,
      home: () => '/home/user',
      cwd: () => '/project',
    });

    const result = await claudeCodeWriter.write(deps, defaultOptions());

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toEqual(['commands']);
    expect(fs.written['/home/user/.claude.json.tmp']).toBeUndefined();
  });
});
