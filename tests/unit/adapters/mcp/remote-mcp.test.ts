import { describe, it, expect } from 'vitest';
import {
  NotImplementedError,
  NotImplementedRemoteMcpAdapter,
  type RemoteMcpAdapter,
} from '../../../../src/adapters/mcp/remote-mcp.js';

/**
 * The remote MCP adapter is an interface and a default implementation. The default `dispatch`
 * rejects with `NotImplementedError`, because the remote behavior does not exist yet.
 */
describe('RemoteMcpAdapter (DR-6 skeleton)', () => {
  /**
   * `satisfies` and the typed binding are compile-time checks of the interface shape.
   * The runtime assertions only show that the two methods exist.
   */
  it('RemoteMcpAdapter_Interface_CompilesAsTypeShape', () => {
    const adapter = {
      async dispatch(_tool: string, _args: unknown): Promise<unknown> {
        return undefined;
      },
      async close(): Promise<void> {
      },
    } satisfies RemoteMcpAdapter;

    const concrete: RemoteMcpAdapter = new NotImplementedRemoteMcpAdapter();

    expect(typeof adapter.dispatch).toBe('function');
    expect(typeof adapter.close).toBe('function');
    expect(typeof concrete.dispatch).toBe('function');
    expect(typeof concrete.close).toBe('function');
  });

  it('NotImplementedRemoteMcpAdapter_Dispatch_ThrowsNotImplementedError', async () => {
    const adapter = new NotImplementedRemoteMcpAdapter();

    await expect(adapter.dispatch('any', {})).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('NotImplementedRemoteMcpAdapter_Close_ResolvesNoop', async () => {
    const adapter = new NotImplementedRemoteMcpAdapter();

    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
