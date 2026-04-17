import { describe, it, expect, beforeEach } from 'vitest';
import { CursorWriter } from './cursor.js';
import type { ConfigWriteResult } from '../schema.js';

// ─── In-memory fs stub ─────────────────────────────────────────────────────

interface FsStub {
  files: Map<string, string>;
  dirs: Set<string>;
  readFile(p: string, enc: BufferEncoding): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
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
  };
}

describe('CursorWriter', () => {
  let fs: FsStub;

  beforeEach(() => {
    fs = createFsStub();
  });

  it('CursorWriter_Write_CreatesCursorMcpJson', async () => {
    // .cursor dir exists but no mcp.json
    fs.dirs.add('/project/.cursor');

    const writer = new CursorWriter({ fs });
    const result: ConfigWriteResult = await writer.write('/project');

    expect(result.runtime).toBe('cursor');
    expect(result.status).toBe('written');
    expect(result.componentsWritten).toContain('mcp-config');

    const written = fs.files.get('/project/.cursor/mcp.json');
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

  it('CursorWriter_Write_PreservesExistingServers', async () => {
    const existing = JSON.stringify(
      {
        mcpServers: {
          'other-tool': {
            command: 'python',
            args: ['serve.py'],
            type: 'stdio',
          },
        },
      },
      null,
      2,
    );
    fs.dirs.add('/project/.cursor');
    fs.files.set('/project/.cursor/mcp.json', existing);

    const writer = new CursorWriter({ fs });
    const result = await writer.write('/project');

    expect(result.status).toBe('written');

    const written = fs.files.get('/project/.cursor/mcp.json');
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);

    // Other server preserved
    expect(parsed.mcpServers['other-tool']).toBeDefined();
    expect(parsed.mcpServers['other-tool'].command).toBe('python');

    // Exarchos added
    expect(parsed.mcpServers.exarchos).toBeDefined();
    expect(parsed.mcpServers.exarchos.command).toBe('npx');
  });
});
