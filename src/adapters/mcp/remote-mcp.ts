// RESERVED(issue: #1081, owner: exarchos, expires: 2026-10-31) — remote-MCP skeleton. No handler or registry uses it.
//
// The module ships the interface and a default that throws, so other code can use the type with no runtime risk.

/** The error that a placeholder throws for behavior that does not exist yet. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * An adapter that dispatches tool calls to a remote MCP server. Connection pooling, auth and
 * retries land under #1081.
 */
export interface RemoteMcpAdapter {
  dispatch(tool: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The default `RemoteMcpAdapter`. Each `dispatch` call rejects with a `NotImplementedError`.
 * `close` does nothing, so a teardown path can call it safely.
 */
export class NotImplementedRemoteMcpAdapter implements RemoteMcpAdapter {
  async dispatch(_tool: string, _args: unknown): Promise<never> {
    throw new NotImplementedError(
      'remote-mcp not implemented (tracking: #1081)',
    );
  }

  async close(): Promise<void> {
  }
}
