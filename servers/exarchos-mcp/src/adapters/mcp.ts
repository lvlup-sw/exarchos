import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getFullRegistry, buildRegistrationSchema, buildToolDescription } from '../registry.js';
import { formatResult } from '../format.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
// Server identity constants (duplicated from index.ts to avoid circular imports)
const SERVER_NAME = 'exarchos-mcp';
const SERVER_VERSION = '1.1.0';

// ─── MCP Server Adapter ────────────────────────────────────────────────────

/**
 * Creates an MCP server instance that routes tool calls through the
 * transport-agnostic dispatch layer.
 *
 * Each registered tool handler:
 * 1. Calls dispatch() with the tool name, args, and context
 * 2. Wraps the ToolResult with formatResult() for MCP wire format
 */
export function createMcpServer(ctx: DispatchContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of getFullRegistry()) {
    if (tool.hidden) continue;
    const inputSchema = buildRegistrationSchema(tool.actions);
    const description = buildToolDescription(tool);

    const toolName = tool.name;

    // MCP handler: dispatch → formatResult (with error boundary)
    const mcpHandler = async (args: Record<string, unknown>) => {
      try {
        return formatResult(await dispatch(toolName, args, ctx));
      } catch (error) {
        return formatResult({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Unhandled MCP dispatch error',
          },
        });
      }
    };

    // Use registerTool() so the strict ZodObject is passed as inputSchema
    // directly, preserving .strict() validation that rejects unrecognized keys.
    server.registerTool(
      tool.name,
      { description, inputSchema },
      mcpHandler,
    );
  }

  return server;
}
