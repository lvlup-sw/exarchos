// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.4 (T4.7)
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../fixtures/hermetic.js';
import { spawnMcpClient } from '../../fixtures/mcp-client.js';

const SIGTERM_GRACE_MS = 3_000;

describe('exarchos mcp', () => {
  it('mcp_start_acceptsInitializeOverStdio', async () => {
    await withHermeticEnv(async () => {
      // spawnMcpClient defaults to `exarchos mcp`; the resolve path runs the
      // initialize handshake, so getting here means the binary spoke MCP
      // over stdio. listTools confirms the registered tool surface is wired.
      const handle = await spawnMcpClient();
      try {
        const resp = await handle.client.listTools();
        expect(resp.tools.length).toBeGreaterThan(0);
      } finally {
        await handle.terminate();
      }
    });
  });

  it('mcp_sigterm_exitsCleanlyWithinThreeSeconds', async () => {
    await withHermeticEnv(async () => {
      const handle = await spawnMcpClient();
      const start = Date.now();
      await handle.terminate();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThanOrEqual(SIGTERM_GRACE_MS);
      // The fixture's terminate() sends SIGTERM via client.close (which
      // closes stdio), waits for natural exit, and only escalates to
      // SIGKILL after a 3s grace. A clean exit means the child caught
      // the stdio close and shut down before the grace fired.
      expect(handle.server.signalCode).not.toBe('SIGKILL');
    });
  });
});
