import { describe, it, expect, afterEach } from 'vitest';
import { spawnMcpClient, type SpawnedMcpClient } from '../fixtures/mcp-client.js';
import { clear, listAlive } from '../fixtures/process-tracker.js';

/**
 * Process-suite test for the v2.9 mode-dispatch default. Lives under
 * `test/process/` (not `test/fixtures/`) because it spawns the real
 * `exarchos` binary on PATH — the process suite's preflight asserts the
 * binary is installed and reports a v2.9.x version, so this test is only
 * exercised when those preconditions hold.
 */

const activeClients: SpawnedMcpClient[] = [];

function track<T extends SpawnedMcpClient>(c: T): T {
  activeClients.push(c);
  return c;
}

describe('spawnMcpClient default command (v2.9 mode dispatch)', () => {
  afterEach(async () => {
    while (activeClients.length > 0) {
      const c = activeClients.pop();
      if (!c) continue;
      try {
        await c.terminate();
      } catch {
        // ignore — teardown best effort
      }
    }
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    clear();
  });

  it('spawnMcpClient_defaultCommand_spawnsExarchosMcpSubcommand', async () => {
    // v2.9 ships a single `exarchos` binary that dispatches subcommand
    // modes — `exarchos mcp` is the MCP-server entrypoint (see
    // src/adapters/cli.ts §"MCP server mode command").
    // Calling spawnMcpClient() with no overrides must default to spawning
    // `exarchos mcp ...`, NOT the deprecated standalone `exarchos-mcp`
    // binary that PR #1166 originally assumed.
    const spawned = track(await spawnMcpClient());
    const spawnargs = spawned.server.spawnargs;
    expect(spawnargs.length).toBeGreaterThanOrEqual(2);
    expect(spawnargs[0]).toMatch(/(^|[\\/])exarchos(\.exe)?$/);
    expect(spawnargs[1]).toBe('mcp');
  });
});
