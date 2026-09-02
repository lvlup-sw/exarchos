/**
 * CopilotWriter — writes `.vscode/mcp.json` with exarchos MCP server entry.
 *
 * Read-modify-write: reads existing file (preserving other servers),
 * merges the exarchos entry, and writes atomically via tmp+rename.
 */

import { McpJsonWriter, type McpJsonWriterDeps } from './mcp-json-writer.js';

export type CopilotWriterDeps = McpJsonWriterDeps;

export class CopilotWriter extends McpJsonWriter {
  readonly runtime = 'copilot';
  protected readonly configDir = '.vscode';

  constructor(deps?: CopilotWriterDeps) {
    super(deps);
  }
}
