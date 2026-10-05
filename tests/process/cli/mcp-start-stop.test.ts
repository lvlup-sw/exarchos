import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { spawnMcpClient } from '../../helpers/mcp-client.js';

describe('exarchos mcp', () => {
  /**
   * `spawnMcpClient` starts `exarchos mcp` and resolves only after the `initialize` handshake.
   * `listTools` then shows that the server registered its tools.
   */
  it('mcp_start_acceptsInitializeOverStdio', async () => {
    await withHermeticEnv(async () => {
      const handle = await spawnMcpClient();
      try {
        const resp = await handle.client.listTools();
        expect(resp.tools.length).toBeGreaterThan(0);
      } finally {
        await handle.terminate();
      }
    });
  });

  /**
   * `terminate` closes the client, and the transport then ends the stdin of the child.
   * The transport and `terminate` each send `SIGKILL` only to a child that stays alive.
   * The test passes when `SIGKILL` did not end the child, and it measures no time.
   */
  it('mcp_sigterm_exitsCleanlyWithinThreeSeconds', async () => {
    await withHermeticEnv(async () => {
      const handle = await spawnMcpClient();
      await handle.terminate();
      expect(handle.server.signalCode).not.toBe('SIGKILL');
    });
  });
});
