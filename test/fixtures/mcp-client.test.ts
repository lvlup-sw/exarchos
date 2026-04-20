import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnMcpClient, type SpawnedMcpClient } from './mcp-client.js';
import { clear, listAlive } from './process-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, '__helpers__', 'mock-mcp-server.mjs');

/**
 * Track clients across a single test so teardown can clean up a handle even
 * when an assertion fails mid-test and `terminate()` never runs.
 */
const activeClients: SpawnedMcpClient[] = [];

function track<T extends SpawnedMcpClient>(c: T): T {
  activeClients.push(c);
  return c;
}

describe('spawnMcpClient', () => {
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
    // Force-kill any leaked children, then reset the tracker so each test
    // starts from an empty registry.
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    clear();
  });

  it('SpawnMcpClient_MockServer_ConnectsAndListsTools', async () => {
    const spawned = track(
      await spawnMcpClient({ command: 'node', args: [MOCK_SERVER] }),
    );
    const result = await spawned.client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('echo');
  });

  it('SpawnMcpClient_CallToolOnMockServer_ReturnsExpectedContent', async () => {
    const spawned = track(
      await spawnMcpClient({ command: 'node', args: [MOCK_SERVER] }),
    );
    const result = await spawned.client.callTool({
      name: 'echo',
      arguments: { message: 'hello' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hello' }]);
  });

  it('SpawnMcpClient_ServerExitsBeforeInitialize_RejectsWithStderr', async () => {
    await expect(
      spawnMcpClient({
        command: 'node',
        args: ['-e', 'process.stderr.write("boom"); process.exit(1);'],
        timeout: 5000,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('SpawnMcpClient_InitTimeout_RejectsCleanly', async () => {
    // A child that opens stdio but never speaks MCP: initialize must time out.
    await expect(
      spawnMcpClient({
        command: 'node',
        args: ['-e', 'setInterval(()=>{}, 10000)'],
        timeout: 500,
      }),
    ).rejects.toThrow(/timed? out|timeout/i);
    // No dangling client was returned, but the child we started should have
    // been torn down — assert there are no leaks after rejection.
    expect(listAlive()).toHaveLength(0);
  });

  it('SpawnMcpClient_TerminateIdempotent_CanCallTwice', async () => {
    const spawned = await spawnMcpClient({
      command: 'node',
      args: [MOCK_SERVER],
    });
    await spawned.terminate();
    // Second call must not throw.
    await expect(spawned.terminate()).resolves.toBeUndefined();
  });

  it('SpawnMcpClient_StderrCapture_AccessibleOnSpawnedMcpClient', async () => {
    const spawned = track(
      await spawnMcpClient({ command: 'node', args: [MOCK_SERVER] }),
    );
    expect(Array.isArray(spawned.stderr)).toBe(true);
  });

  it('SpawnMcpClient_RegistersWithProcessTracker_UnregistersAfterTerminate', async () => {
    const spawned = await spawnMcpClient({
      command: 'node',
      args: [MOCK_SERVER],
    });
    expect(listAlive()).toContain(spawned.server);
    await spawned.terminate();
    expect(listAlive()).not.toContain(spawned.server);
  });
});
