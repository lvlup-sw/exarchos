import { describe, it, expect } from 'vitest';
import { claudeCodeWriter } from './claude-code.js';
import { atomicWriteJson } from './claude-code.js';
import { makeStubWriterDeps } from '../probes.js';
import type { WriterFs } from '../probes.js';
import type { WriteOptions } from './writer.js';

/** In-memory filesystem for testing. Tracks all writes and renames. */
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
      if (p in store || dirs.has(p)) {
        return {
          isDirectory: () => dirs.has(p),
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

describe('atomicWriteJson', () => {
  it('AtomicWriteJson_WritesToTmpThenRenames', async () => {
    const fs = makeMemFs();
    const deps = makeStubWriterDeps({ fs });

    await atomicWriteJson(deps, '/config/test.json', { hello: 'world' });

    // Should have written to .tmp first, then renamed
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

    // Verify the written config has mcpServers.exarchos
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
    // Should have updated the exarchos entry
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

    // Verify atomic pattern: write to .tmp then rename
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
});
