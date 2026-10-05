import { describe, it, expect, afterEach } from 'vitest';
import { spawnMcpClient, type SpawnedMcpClient } from '../helpers/mcp-client.js';
import { clear, listAlive } from '../helpers/process-tracker.js';

/** The clients that `afterEach` must terminate. */
const activeClients: SpawnedMcpClient[] = [];

function track<T extends SpawnedMcpClient>(c: T): T {
  activeClients.push(c);
  return c;
}

describe('spawnMcpClient default command (v2.9 mode dispatch)', () => {
  /** Teardown ignores each `terminate` and `kill` error, because the child can be gone already. */
  afterEach(async () => {
    while (activeClients.length > 0) {
      const c = activeClients.pop();
      if (!c) continue;
      try {
        await c.terminate();
      } catch {
      }
    }
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }
    clear();
  });

  /**
   * One `exarchos` binary dispatches its modes by subcommand, and `exarchos mcp` starts the MCP server.
   * Without overrides, `spawnMcpClient` must spawn that subcommand and not a separate `exarchos-mcp` binary.
   */
  it('spawnMcpClient_defaultCommand_spawnsExarchosMcpSubcommand', async () => {
    const spawned = track(await spawnMcpClient());
    const spawnargs = spawned.server.spawnargs;
    expect(spawnargs.length).toBeGreaterThanOrEqual(2);
    expect(spawnargs[0]).toMatch(/(^|[\\/])exarchos(\.exe)?$/);
    expect(spawnargs[1]).toBe('mcp');
  });
});
