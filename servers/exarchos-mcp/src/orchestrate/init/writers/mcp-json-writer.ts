/**
 * Shared MCP JSON config writer — read-modify-write pattern for runtimes
 * that store MCP server config in a JSON file (e.g. `.vscode/mcp.json`,
 * `.cursor/mcp.json`).
 *
 * Extracted to eliminate duplication between CopilotWriter and CursorWriter.
 * Each concrete writer specifies only its target directory and runtime name.
 */

import { join } from 'node:path';
import { promises as nodeFs } from 'node:fs';
import type { ConfigWriteResult } from '../schema.js';
import type { AgentRuntimeName } from '../../../runtime/agent-environment-detector.js';
import type { RuntimeConfigWriter, WriteOptions } from './writer.js';
import type { WriterDeps } from '../probes.js';

// ─── Shared types ───────────────────────────────────────────────────────────

/** Narrow fs surface for testability. */
export interface McpJsonWriterFs {
  readFile(p: string, enc: BufferEncoding): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface McpJsonWriterDeps {
  readonly fs?: McpJsonWriterFs;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EXARCHOS_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', '@anthropic-ai/claude-code', '--mcp-server-name=exarchos'],
  type: 'stdio',
} as const;

const DEFAULT_FS: McpJsonWriterFs = {
  readFile: (p, enc) => nodeFs.readFile(p, enc),
  writeFile: (p, data) => nodeFs.writeFile(p, data, 'utf8'),
  rename: (src, dst) => nodeFs.rename(src, dst),
  mkdir: (p, opts) => nodeFs.mkdir(p, opts).then(() => undefined),
};

// ─── Base class ─────────────────────────────────────────────────────────────

/**
 * Base config writer for runtimes that use a JSON file containing
 * `{ mcpServers: { ... } }`. Subclasses set `runtime` and `configDir`
 * (relative to project root).
 */
export abstract class McpJsonWriter implements RuntimeConfigWriter {
  abstract readonly runtime: AgentRuntimeName;
  /** Directory relative to project root (e.g. '.vscode', '.cursor'). */
  protected abstract readonly configDir: string;

  protected readonly fs: McpJsonWriterFs;

  constructor(deps?: McpJsonWriterDeps) {
    this.fs = deps?.fs ?? DEFAULT_FS;
  }

  async write(_deps: WriterDeps, options: WriteOptions): Promise<ConfigWriteResult> {
    const dirPath = join(options.projectRoot, this.configDir);
    const configPath = join(dirPath, 'mcp.json');
    const tmpPath = join(dirPath, 'mcp.json.tmp');

    // Ensure target directory exists
    await this.fs.mkdir(dirPath, { recursive: true });

    // Read existing config or start fresh
    let existing: Record<string, unknown> = {};
    try {
      const raw = await this.fs.readFile(configPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (err: unknown) {
      if (!isMissingPathError(err)) throw err;
    }

    // Merge exarchos MCP entry
    const mcpServers =
      typeof existing.mcpServers === 'object' && existing.mcpServers !== null
        ? { ...(existing.mcpServers as Record<string, unknown>) }
        : {};
    mcpServers.exarchos = { ...EXARCHOS_MCP_ENTRY };

    const merged = { ...existing, mcpServers };
    const content = JSON.stringify(merged, null, 2) + '\n';

    // Atomic write: tmp → rename
    await this.fs.writeFile(tmpPath, content);
    await this.fs.rename(tmpPath, configPath);

    return {
      runtime: this.runtime,
      status: 'written',
      componentsWritten: ['mcp-config'],
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
