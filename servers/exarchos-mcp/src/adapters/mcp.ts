import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getFullRegistry, buildRegistrationSchema, buildToolDescription } from '../registry.js';
import { formatResult } from '../format.js';
import type { Envelope, ErrorEnvelope } from '../format.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { EnvelopeSchema } from '../schemas/envelope.js';

// ─── D.4: LCD outputSchema advertised to MCP clients ────────────────────────
//
// Single advertised carrier schema (design §2.2, #1287). Every visible tool
// registers this LCD as its `outputSchema`; tightly-typed per-action schemas
// are enforced downstream in the call path (D.5) rather than in the
// tools/list manifest. This keeps the static surface compact and lets the
// per-call validator emit issue-pathed diagnostics.
const LCD_OUTPUT_SCHEMA = EnvelopeSchema(z.unknown());

// ─── D.1: Envelope → MCP CallToolResult carrier mapping ────────────────────

/**
 * Map an Exarchos envelope onto the MCP `CallToolResult` carrier.
 *
 * MCP 2025-11-25 §Tools / Structured Content: SHOULD also return the
 * serialized JSON in a TextContent block for backwards compatibility.
 * We honour that — clients reading `content[0].text` keep working; the
 * new validated payload rides `structuredContent`.
 *
 * Envelope construction lives in `format.ts` (`toEnvelope`); this adapter
 * only handles the carrier mapping. `createMcpServer` is NOT yet wired
 * to this function — the cutover lands in task D.7.
 *
 * Design §2.3. Issue #1287.
 */
export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env) }],
    structuredContent: env,
    isError: env.success === false,
  };
}
// Server identity constants. These must stay in lock-step with the canonical
// SERVER_NAME / SERVER_VERSION exports in src/index.ts — task 1.6's compiled
// binary integration test asserts that the version advertised over MCP's
// initialize handshake matches the index.ts export, so drift here is caught
// in CI. A static `import { SERVER_VERSION } from '../index.js'` would pull
// the full index graph (event-store, backend init, hooks, CLI) into every
// caller of this adapter, so the values are duplicated intentionally; the
// integration test pins them together.
const SERVER_NAME = 'exarchos-mcp';
const SERVER_VERSION = '2.10.0-preview.2';

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
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
        },
      },
    },
  );

  for (const tool of getFullRegistry()) {
    // Tier model — INTENTIONAL asymmetry between MCP and CLI surfaces.
    //
    // `hidden: true` means the tool is excluded from MCP `tools/list` (so it
    // is not advertised to model-side agents and does not consume their
    // context budget) but remains reachable via the CLI for operators,
    // scripts, and introspection (`exarchos schema`, `exarchos sy ...`).
    //
    // The companion CLI introspection path (`listSchemas()` in
    // `./schema-introspection.ts`) deliberately returns the FULL registry
    // and tags hidden tools so users can see they exist while understanding
    // they are internal / not part of the model-facing contract.
    //
    // See bug #1218 for the triage that fixed this asymmetry as
    // intentional, and registry.ts:`CompositeTool.hidden` for the field
    // contract.
    if (tool.hidden) continue;
    const inputSchema = buildRegistrationSchema(tool.actions);
    const description = buildToolDescription(tool, ctx.slimRegistration ?? false);

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
      { description, inputSchema, outputSchema: LCD_OUTPUT_SCHEMA },
      mcpHandler,
    );
  }

  return server;
}
