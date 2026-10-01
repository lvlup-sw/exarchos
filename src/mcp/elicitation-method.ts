/**
 * Adapts the MCP SDK `elicitation/create` request to the {@link ElicitationClient} that `dispatch/elicitation-dispatch.ts` uses.
 * The SDK import stays in `mcp/`, so dispatch depends only on transport-agnostic types.
 * The form-mode `requestedSchema` allows only a small subset of JSON Schema. A simple string field fits it, but a nested field needs a shaping pass here.
 */

import type { ElicitationClient } from '../dispatch/elicitation-dispatch.js';

/**
 * The part of the MCP SDK `Server` that this adapter uses. A test can inject a stub with no transport.
 */
export interface ElicitationSdkServer {
  elicitInput(params: {
    mode: 'form';
    message: string;
    requestedSchema: Record<string, unknown>;
  }): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/**
 * Builds an {@link ElicitationClient} on the SDK `elicitation/create` method. It converts `{field, schema}` to form-mode params, and the result to `{value}`.
 * An accepted result returns `content[field]`. Any other result returns `{value: undefined}`, and the caller returns the INVALID_INPUT error.
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
