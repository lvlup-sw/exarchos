import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getFullRegistry,
  buildRegistrationSchema,
  buildToolDescription,
} from '../registry.js';
import type { ToolAction } from '../registry.js';
import { toEnvelope } from '../format.js';
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
//
// The LCD is the canonical `EnvelopeSchema(z.unknown())` discriminated union
// (success/error branches keyed on the `success` boolean literal). This
// was previously a passthrough-ZodObject workaround because the SDK's
// `normalizeObjectSchema` (`zod-compat.ts:79-121`) only accepted plain
// `ZodObject` and returned `undefined` for `ZodDiscriminatedUnion`,
// silently dropping the outputSchema from `tools/list` and crashing
// `validateToolOutput` on every successful call. PR #1366 fixes both gaps
// via `patches/@modelcontextprotocol+sdk+1.29.0.patch` and the upstream
// issues at modelcontextprotocol/typescript-sdk#2084 (tools/list draft-7
// → 2020-12 to admit `z.discriminatedUnion`'s `anyOf` JSON-Schema form)
// and #1308 (DU acceptance in `normalizeObjectSchema`). Once those
// upstream fixes ship in a stable SDK release, the patch drops; the LCD
// stays as-is.
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
 * only handles the carrier mapping. `createMcpServer` (this file's main
 * export, below) wires `toMcpResult` into the per-tool MCP handler — that
 * cutover landed in D.7.
 *
 * Design §2.3. Issue #1287.
 */
export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env) }],
    // The SDK's `CallToolResult` types `structuredContent` as
    // `{[x: string]: unknown} | undefined` (an index-signatured object).
    // Our envelope types use named-readonly fields — semantically a JSON
    // object, but without an explicit string index signature. Cast through
    // `unknown` so the carrier crosses the SDK boundary without leaking a
    // structural mismatch into call sites.
    structuredContent: env as unknown as { [x: string]: unknown },
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

// ─── D.6: Aggregate ActionAnnotations into tools/list ToolAnnotations ─────
//
// MCP `tools/list` carries ToolAnnotations as advisory hints (per the spec
// these are explicitly client-untrusted unless the server itself is
// trusted). We aggregate the per-action `ActionAnnotations` records into a
// single tool-level record using the design's logical rules:
//
//   readOnlyHint    — true iff EVERY action is read-only. Conservative AND:
//                     one mutating action poisons the read-only label.
//   destructiveHint — true iff ANY action is destructive. Surfaces the
//                     worst-case safety so clients can prompt for confirm.
//   idempotentHint  — true iff EVERY action is documented/safe to re-run.
//   openWorldHint   — true iff ANY action touches an external world
//                     (network, git, etc.).
//
// Design §2.4, issue #1289.
function aggregateToolAnnotations(
  actions: readonly ToolAction[],
): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: actions.every(a => a.annotations.readOnly),
    destructiveHint: actions.some(a => a.annotations.destructive),
    idempotentHint: actions.every(a => a.annotations.idempotent),
    openWorldHint: actions.some(a => a.annotations.openWorld),
  };
}

// ─── D.5: Per-call output schema validation ────────────────────────────────
//
// Locates the dispatched action by the canonical `args.action` discriminator
// and validates the post-dispatch envelope against the action's per-action
// `outputSchema`. On violation, returns a replacement INTERNAL_ERROR
// envelope carrying the Zod issue list under `_meta.outputSchemaViolation`
// (path + message tuples). On success, returns the input envelope unchanged.
//
// When the action discriminator is absent or unresolved (custom tools
// without a registered action, malformed args, etc.), validation is skipped
// — the dispatch boundary surfaces its own structured error in those cases,
// and double-wrapping would mask the original failure path.
//
// Design §2.2 / §3, issue #1287. Validation cost is sub-millisecond in
// practice (small Zod schemas, no I/O); if a future regression flips that,
// gate behind an `EXARCHOS_OUTPUT_VALIDATE` env var.
function validateAgainstActionSchema(
  toolName: string,
  actions: readonly ToolAction[],
  args: Record<string, unknown>,
  env: Envelope<unknown> | ErrorEnvelope,
): Envelope<unknown> | ErrorEnvelope {
  const actionName =
    typeof args === 'object' && args !== null && typeof args.action === 'string'
      ? (args.action as string)
      : undefined;
  if (actionName === undefined) {
    return env;
  }
  const action = actions.find(a => a.name === actionName);
  if (action === undefined) {
    return env;
  }
  const parsed = action.outputSchema.safeParse(env);
  if (parsed.success) {
    return env;
  }
  const outputSchemaViolation = parsed.error.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return toEnvelope({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: `Output schema violation for action '${toolName}.${actionName}'`,
    },
    _meta: { outputSchemaViolation },
  });
}

// ─── MCP Server Adapter ────────────────────────────────────────────────────

/**
 * Creates an MCP server instance that routes tool calls through the
 * transport-agnostic dispatch layer.
 *
 * Each registered tool handler:
 * 1. Calls dispatch() with the tool name, args, and context
 * 2. Converts the ToolResult to an Envelope via `toEnvelope`
 * 3. Validates the envelope against the per-action outputSchema (D.5)
 * 4. Maps the envelope onto the MCP CallToolResult carrier via
 *    `toMcpResult` so both `content[0].text` (legacy SHOULD per MCP spec)
 *    and `structuredContent` (the typed envelope payload) ride together.
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

    // MCP handler: dispatch → toEnvelope → per-action schema validation
    // → toMcpResult. The `toEnvelope` + `toMcpResult` carriers replace the
    // pre-D.7 single-carrier path and add per-call enforcement of the
    // per-action outputSchema (D.5).
    const mcpHandler = async (args: Record<string, unknown>) => {
      let env: Envelope<unknown> | ErrorEnvelope;
      try {
        const result = await dispatch(toolName, args, ctx);
        env = toEnvelope(result);
      } catch (error) {
        env = toEnvelope({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message:
              error instanceof Error ? error.message : 'Unhandled MCP dispatch error',
          },
        });
        // Skip per-action validation on the unhandled-throw path — there is
        // no action contract to enforce against an out-of-band crash.
        return toMcpResult(env);
      }

      // D.5 — per-action output schema enforcement. Looks up the action via
      // the canonical `args.action` discriminator and re-validates the
      // envelope shape; surface the violation as an INTERNAL_ERROR envelope
      // carrying the Zod issue list under `_meta.outputSchemaViolation` so
      // callers can self-diagnose contract drift without re-running.
      env = validateAgainstActionSchema(toolName, tool.actions, args, env);
      return toMcpResult(env);
    };

    // Use registerTool() so the strict ZodObject is passed as inputSchema
    // directly, preserving .strict() validation that rejects unrecognized keys.
    const annotations = aggregateToolAnnotations(tool.actions);
    server.registerTool(
      tool.name,
      { description, inputSchema, outputSchema: LCD_OUTPUT_SCHEMA, annotations },
      mcpHandler,
    );
  }

  return server;
}
