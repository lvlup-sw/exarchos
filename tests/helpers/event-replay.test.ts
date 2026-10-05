/**
 * Tests for `snapshotEventStream` and `replayInto`. Each test spawns the real MCP server
 * with `bun`, inside a hermetic environment.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnMcpClient, type SpawnedMcpClient } from './mcp-client.js';
import { withHermeticEnv } from './hermetic.js';
import { clear, listAlive } from './process-tracker.js';
import {
  snapshotEventStream,
  replayInto,
  type EventSnapshot,
} from './event-replay.js';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_ENTRY = path.join(
  REPO_ROOT,
  'src',
  'index.ts',
);

/**
 * The arguments for the MCP server. Each test runs it with `bun`, so `bun:sqlite` resolves
 * natively. `src/storage/sqlite-backend.ts` imports that module, and the ESM loader of Node
 * rejects the `bun:` URL scheme.
 */
const REAL_MCP_ARGS = [MCP_ENTRY, 'mcp'];

/**
 * Track clients across a single test so teardown can clean up handles even
 * when an assertion fails mid-test and `terminate()` never runs.
 */
const activeClients: SpawnedMcpClient[] = [];
function track<T extends SpawnedMcpClient>(c: T): T {
  activeClients.push(c);
  return c;
}

describe('event-replay primitives', () => {
  /**
   * The `unit` project does not check that the `exarchos` binary exists, so this hook checks
   * the MCP entry file. It also probes `bun`, which each test spawns. Without the probe, a
   * missing `bun` shows late as an `ENOENT` inside `transport.start()`.
   */
  beforeAll(async () => {
    if (!fs.existsSync(MCP_ENTRY)) {
      throw new Error(`MCP entry not found at ${MCP_ENTRY}.`);
    }
    const probe = await spawnAsync('bun', ['--version']);
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `bun not found on PATH (required to spawn the MCP server because ` +
          `it imports 'bun:sqlite'). Install via https://bun.sh and retry.`,
      );
    }
  });

  /** Teardown is best effort. It ignores a failed `terminate()` and a failed `kill`. */
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

  describe('snapshotEventStream', () => {
    it('snapshotEventStream_freshFeature_returnsEmptySnapshot', async () => {
      await withHermeticEnv(async (env) => {
        const spawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );
        const snap = await snapshotEventStream(spawned, 'fresh-feat');
        expect(snap.featureId).toBe('fresh-feat');
        expect(snap.events).toEqual([]);
      });
    }, 30_000);

    /**
     * `init` appends `workflow.started` itself, and the test appends two events. The snapshot
     * must keep that order.
     */
    it('snapshotEventStream_afterEvents_includesAllEventsInOrder', async () => {
      await withHermeticEnv(async (env) => {
        const spawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );

        await spawned.client.callTool({
          name: 'exarchos_workflow',
          arguments: {
            action: 'init',
            featureId: 'saga-order',
            workflowType: 'feature',
          },
        });
        await spawned.client.callTool({
          name: 'exarchos_event',
          arguments: {
            action: 'append',
            stream: 'saga-order',
            event: {
              type: 'task.assigned',
              data: { taskId: 't1', title: 'first task' },
            },
          },
        });
        await spawned.client.callTool({
          name: 'exarchos_event',
          arguments: {
            action: 'append',
            stream: 'saga-order',
            event: {
              type: 'task.progressed',
              data: { taskId: 't1', tddPhase: 'red' },
            },
          },
        });

        const snap = await snapshotEventStream(spawned, 'saga-order');
        expect(snap.featureId).toBe('saga-order');
        expect(snap.events.length).toBeGreaterThanOrEqual(3);
        const types = snap.events.map(
          (e) => (e as Record<string, unknown>).type,
        );
        const startedIdx = types.indexOf('workflow.started');
        const assignedIdx = types.indexOf('task.assigned');
        const progressedIdx = types.indexOf('task.progressed');
        expect(startedIdx).toBeGreaterThanOrEqual(0);
        expect(assignedIdx).toBeGreaterThan(startedIdx);
        expect(progressedIdx).toBeGreaterThan(assignedIdx);
      });
    }, 30_000);

    /**
     * Each `timestamp` must be `<TIMESTAMP>`, and each `sequence` must be `<SEQ>`. The test
     * checks a field only when the event has it.
     */
    it('snapshotEventStream_appliesNormalize_replacesTimestamps', async () => {
      await withHermeticEnv(async (env) => {
        const spawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );

        await spawned.client.callTool({
          name: 'exarchos_workflow',
          arguments: {
            action: 'init',
            featureId: 'norm-feat',
            workflowType: 'feature',
          },
        });

        const snap = await snapshotEventStream(spawned, 'norm-feat');
        expect(snap.events.length).toBeGreaterThanOrEqual(1);
        for (const e of snap.events) {
          const obj = e as Record<string, unknown>;
          if ('timestamp' in obj) {
            expect(obj.timestamp).toBe('<TIMESTAMP>');
          }
          if ('sequence' in obj) {
            expect(obj.sequence).toBe('<SEQ>');
          }
        }
      });
    }, 30_000);
  });

  describe('replayInto', () => {
    /**
     * The source server and the target server each run in their own hermetic environment.
     * The assertions on the source snapshot are a guardrail. Without them, a broken source
     * setup gives an empty snapshot, and the comparison of two empty arrays passes.
     */
    it('replayInto_emptyTarget_appliesAllEvents', async () => {
      const snap = await withHermeticEnv(async (env) => {
        const sourceSpawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );
        await sourceSpawned.client.callTool({
          name: 'exarchos_workflow',
          arguments: {
            action: 'init',
            featureId: 'replay-feat',
            workflowType: 'feature',
          },
        });
        await sourceSpawned.client.callTool({
          name: 'exarchos_event',
          arguments: {
            action: 'append',
            stream: 'replay-feat',
            event: {
              type: 'task.assigned',
              data: { taskId: 'r1', title: 'replay task' },
            },
          },
        });
        const captured = await snapshotEventStream(
          sourceSpawned,
          'replay-feat',
        );
        await sourceSpawned.terminate();
        const idx = activeClients.indexOf(sourceSpawned);
        if (idx >= 0) activeClients.splice(idx, 1);
        return captured;
      });

      expect(snap.events.length).toBeGreaterThanOrEqual(2);
      const srcTypes = snap.events.map(
        (e) => (e as Record<string, unknown>).type,
      );
      expect(srcTypes).toContain('workflow.started');
      expect(srcTypes).toContain('task.assigned');

      await withHermeticEnv(async (env) => {
        const targetSpawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );
        await replayInto(targetSpawned, snap);
        const after = await snapshotEventStream(targetSpawned, 'replay-feat');
        expect(after.events).toEqual(snap.events);
      });
    }, 60_000);

    /**
     * The assertions on the source snapshot are the same guardrail as in
     * `replayInto_emptyTarget_appliesAllEvents`. A second replay of the same snapshot must add
     * no event.
     */
    it('replayInto_idempotent_secondCallNoOp', async () => {
      const snap: EventSnapshot = await withHermeticEnv(async (env) => {
        const sourceSpawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );
        await sourceSpawned.client.callTool({
          name: 'exarchos_workflow',
          arguments: {
            action: 'init',
            featureId: 'idem-feat',
            workflowType: 'feature',
          },
        });
        await sourceSpawned.client.callTool({
          name: 'exarchos_event',
          arguments: {
            action: 'append',
            stream: 'idem-feat',
            event: {
              type: 'task.assigned',
              data: { taskId: 'i1', title: 'idem task' },
            },
          },
        });
        const captured = await snapshotEventStream(sourceSpawned, 'idem-feat');
        await sourceSpawned.terminate();
        const idx = activeClients.indexOf(sourceSpawned);
        if (idx >= 0) activeClients.splice(idx, 1);
        return captured;
      });

      expect(snap.events.length).toBeGreaterThanOrEqual(2);
      const srcTypes = snap.events.map(
        (e) => (e as Record<string, unknown>).type,
      );
      expect(srcTypes).toContain('workflow.started');
      expect(srcTypes).toContain('task.assigned');

      await withHermeticEnv(async (env) => {
        const targetSpawned = track(
          await spawnMcpClient({
            command: 'bun',
            args: REAL_MCP_ARGS,
            stateDir: env.stateDir,
            timeout: 20_000,
          }),
        );

        await replayInto(targetSpawned, snap);
        const after1 = await snapshotEventStream(targetSpawned, 'idem-feat');
        expect(after1.events.length).toBe(snap.events.length);

        await replayInto(targetSpawned, snap);
        const after2 = await snapshotEventStream(targetSpawned, 'idem-feat');
        expect(after2.events.length).toBe(snap.events.length);
        expect(after2.events).toEqual(after1.events);
      });
    }, 60_000);
  });
});
