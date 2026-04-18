import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotWriter } from './copilot.js';
import type { ConfigWriteResult } from '../schema.js';
import { makeStubWriterDeps } from '../probes.js';
import type { WriteOptions } from './writer.js';

const stubDeps = makeStubWriterDeps();
const defaultOptions: WriteOptions = { projectRoot: '/project', nonInteractive: false, forceOverwrite: false };

// ─── In-memory fs stub ─────────────────────────────────────────────────────

interface FsStub {
  files: Map<string, string>;
  dirs: Set<string>;
  readFile(p: string, enc: BufferEncoding): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  access(p: string): Promise<void>;
}

function createFsStub(): FsStub {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    async readFile(p: string, _enc: BufferEncoding): Promise<string> {
      const content = files.get(p);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return content;
    },
    async writeFile(p: string, data: string): Promise<void> {
      files.set(p, data);
    },
    async rename(src: string, dst: string): Promise<void> {
      const content = files.get(src);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file: ${src}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      files.set(dst, content);
      files.delete(src);
    },
    async mkdir(p: string, _opts?: { recursive?: boolean }): Promise<void> {
      dirs.add(p);
    },
    async access(p: string): Promise<void> {
      if (!files.has(p) && !dirs.has(p)) {
        const err = new Error(`ENOENT: no such file: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
    },
  };
}

describe('CopilotWriter', () => {
  let fs: FsStub;

  beforeEach(() => {
    fs = createFsStub();
  });

  it('CopilotWriter_Write_CreatesVscodeMcpJson', async () => {
    // .vscode dir exists but no mcp.json yet
    fs.dirs.add('/project/.vscode');

    const writer = new CopilotWriter({ fs });
    const result: ConfigWriteResult = await writer.write(stubDeps, defaultOptions);

    expect(result.runtime).toBe('copilot');
    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('mcp-config');

    // Verify the written file
    const written = fs.files.get('/project/.vscode/mcp.json');
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.mcpServers.exarchos).toBeDefined();
    expect(parsed.mcpServers.exarchos.command).toBe('npx');
    expect(parsed.mcpServers.exarchos.args).toEqual([
      '-y',
      '@anthropic-ai/claude-code',
      '--mcp-server-name=exarchos',
    ]);
    expect(parsed.mcpServers.exarchos.type).toBe('stdio');
  });

  it('CopilotWriter_Write_PreservesExistingServers', async () => {
    // Existing mcp.json with another server
    const existing = JSON.stringify(
      {
        mcpServers: {
          'other-server': {
            command: 'node',
            args: ['server.js'],
            type: 'stdio',
          },
        },
      },
      null,
      2,
    );
    fs.dirs.add('/project/.vscode');
    fs.files.set('/project/.vscode/mcp.json', existing);

    const writer = new CopilotWriter({ fs });
    const result = await writer.write(stubDeps, defaultOptions);

    expect(result.status).toBe('written');

    const written = fs.files.get('/project/.vscode/mcp.json');
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);

    // Other server preserved
    expect(parsed.mcpServers['other-server']).toBeDefined();
    expect(parsed.mcpServers['other-server'].command).toBe('node');

    // Exarchos added
    expect(parsed.mcpServers.exarchos).toBeDefined();
    expect(parsed.mcpServers.exarchos.command).toBe('npx');
  });

  it('CopilotWriter_Write_CreatesVscodeDir', async () => {
    // No .vscode directory exists
    const writer = new CopilotWriter({ fs });
    const result = await writer.write(stubDeps, defaultOptions);

    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('mcp-config');

    // Directory should have been created
    expect(fs.dirs.has('/project/.vscode')).toBe(true);

    // File should have been written
    const written = fs.files.get('/project/.vscode/mcp.json');
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.mcpServers.exarchos).toBeDefined();
  });
});
