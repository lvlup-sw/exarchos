// ─── #1274 — MCP `elicitation/create` transport adapter ──────────────────────
//
// Thin wrapper that adapts the MCP SDK Server's `elicitation/create`
// request to the {@link ElicitationClient} surface consumed by
// `dispatch/elicitation-dispatch.ts`. Keeping the adapter in `mcp/` (next
// to `mcp/notifications.ts`) preserves the layering rule that dispatch
// depends only on transport-agnostic types — the SDK is imported HERE
// rather than from dispatch.
//
// The form-mode `requestedSchema` shape demanded by the spec is narrower
// than a generic JSON Schema (only a fixed set of primitive types and
// constructs are allowed; see MCP `ElicitRequestFormParamsSchema`). The
// dispatch helper produces the schema via `.pick({field: true})` on the
// action schema, which for `featureId` / similar string fields will fall
// inside the spec-permitted subset; surfaces that pick a more complex
// nested field will need an explicit shaping pass at this adapter (out
// of scope for #1274).

import type { ElicitationClient } from '../dispatch/elicitation-dispatch.js';

/**
 * Minimal server surface this adapter consumes from the MCP SDK. We
 * structural-type only the `elicitInput` method so test fixtures can
 * inject a stub without spinning up a transport. The real
 * `@modelcontextprotocol/sdk` `Server` exports a compatible signature.
 */
export interface ElicitationSdkServer {
  elicitInput(params: {
    mode: 'form';
    message: string;
    requestedSchema: Record<string, unknown>;
  }): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/**
 * Build an {@link ElicitationClient} backed by the MCP SDK Server's
 * `elicitation/create` method. Translates dispatch's `{field, schema}`
 * surface into the form-mode params and the SDK's `ElicitResult` shape
 * back into `{value}` so dispatch stays transport-agnostic.
 *
 * The `action: 'accept'` branch returns `content[field]`; everything
 * else (`reject`, `cancel`, undefined content) returns `{value: undefined}`
 * so the caller treats the round-trip as un-fulfilled and falls back to
 * the legacy INVALID_INPUT envelope.
 */
export function createElicitationClient(
  server: ElicitationSdkServer,
): ElicitationClient {
  return {
    async create({ field, schema }) {
      const result = await server.elicitInput({
        mode: 'form',
        message: `The server needs you to supply "${field}".`,
        requestedSchema: schema,
      });
      if (result.action !== 'accept' || result.content === undefined) {
        return { value: undefined };
      }
      return { value: result.content[field] };
    },
  };
}
