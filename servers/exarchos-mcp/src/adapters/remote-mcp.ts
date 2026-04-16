// ─── DR-6: RemoteMcpAdapter Interface Skeleton ──────────────────────────────
//
// Placeholder for future remote-MCP deployment work. Ships only the
// interface shape and a throwing default implementation so downstream
// code can reference the type without runtime risk.
//
// Full behavior tracked at: https://github.com/lvlup-sw/exarchos/issues/1081
//
// NOTE: This adapter is intentionally NOT wired into any handler or
// registry. It exists purely as a future-use placeholder.

/**
 * Error thrown by skeleton/placeholder implementations to signal that
 * the requested behavior has not yet been built.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * Interface for an adapter that dispatches tool invocations to a
 * remote MCP server. Deliberately minimal — the real implementation
 * (connection pooling, auth, retries) lands under #1081.
 */
export interface RemoteMcpAdapter {
  dispatch(tool: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Default `RemoteMcpAdapter` that rejects every `dispatch` call with
 * a `NotImplementedError`. `close` is a noop so teardown paths that
 * eagerly call it remain safe.
 */
export class NotImplementedRemoteMcpAdapter implements RemoteMcpAdapter {
  async dispatch(_tool: string, _args: unknown): Promise<never> {
    throw new NotImplementedError(
      'remote-mcp not implemented (tracking: #1081)',
    );
  }

  async close(): Promise<void> {
    /* noop */
  }
}
