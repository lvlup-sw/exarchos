import { describe, it, expect } from 'vitest';
import {
  NotImplementedError,
  NotImplementedRemoteMcpAdapter,
  type RemoteMcpAdapter,
} from './remote-mcp.js';

// ─── DR-6: RemoteMcpAdapter Interface Skeleton ──────────────────────────────
//
// These tests ship the interface shape and a NotImplementedError-throwing
// default implementation. Full remote-MCP behavior is tracked separately
// at issue #1081.

describe('RemoteMcpAdapter (DR-6 skeleton)', () => {
  it('RemoteMcpAdapter_Interface_CompilesAsTypeShape', () => {
    // Arrange — a local object that claims to satisfy the interface shape.
    // `satisfies` forces a compile-time check without widening the type.
    const adapter = {
      async dispatch(_tool: string, _args: unknown): Promise<unknown> {
        return undefined;
      },
      async close(): Promise<void> {
        /* noop */
      },
    } satisfies RemoteMcpAdapter;

    // Act — also confirm the concrete default implementation is assignable
    // to the interface via a plain binding (another compile-time check).
    const concrete: RemoteMcpAdapter = new NotImplementedRemoteMcpAdapter();

    // Assert — the shape carries the two expected method names at runtime.
    expect(typeof adapter.dispatch).toBe('function');
    expect(typeof adapter.close).toBe('function');
    expect(typeof concrete.dispatch).toBe('function');
    expect(typeof concrete.close).toBe('function');
  });

  it('NotImplementedRemoteMcpAdapter_Dispatch_ThrowsNotImplementedError', async () => {
    // Arrange
    const adapter = new NotImplementedRemoteMcpAdapter();

    // Act + Assert — dispatch must reject with a NotImplementedError.
    await expect(adapter.dispatch('any', {})).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('NotImplementedRemoteMcpAdapter_Close_ResolvesNoop', async () => {
    // Arrange
    const adapter = new NotImplementedRemoteMcpAdapter();

    // Act + Assert — close must resolve cleanly (no throw, returns undefined).
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
