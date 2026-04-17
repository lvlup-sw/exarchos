/**
 * CursorWriter — writes `.cursor/mcp.json` with exarchos MCP server entry.
 *
 * Same read-modify-write pattern as CopilotWriter but targeting the
 * Cursor-specific config directory.
 */

import { McpJsonWriter, type McpJsonWriterDeps } from './mcp-json-writer.js';

export type CursorWriterDeps = McpJsonWriterDeps;

export class CursorWriter extends McpJsonWriter {
  readonly runtime = 'cursor';
  protected readonly configDir = '.cursor';

  constructor(deps?: CursorWriterDeps) {
    super(deps);
  }
}
