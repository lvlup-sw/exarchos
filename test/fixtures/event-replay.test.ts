// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.2
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnMcpClient, type SpawnedMcpClient } from './mcp-client.js';
import { withHermeticEnv } from './hermetic.js';
import { clear, listAlive } from './process-tracker.js';
import {
  snapshotEventStream,
  replayInto,
  type EventSnapshot,
} from './event-replay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_ENTRY = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'index.ts',
);

// Spawn the MCP server with `bun` so `bun:sqlite` (imported by
// `servers/exarchos-mcp/src/storage/sqlite-backend.ts` post-#1259) resolves
// natively. `node tsx` is rejected by Node 24's ESM loader on the
// `bun:` URL scheme. Bun is already pinned in CI via `oven-sh/setup-bun@v2`
// and in the `setup-bun` step of the binary matrix workflow.
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
  beforeAll(() => {
    // Confirm the MCP entrypoint is reachable; the fixture self-tests are part
    // of the `unit` project which does not gate on `exarchos` binary presence.
    if (!fs.existsSync(MCP_ENTRY)) {
      throw new Error(`MCP entry not found at ${MCP_ENTRY}.`);
    }
    // Bun preflight — every spawn site below uses `command: 'bun'`. A missing
    // bun would surface late as an opaque ENOENT inside `transport.start()`;
    // probe up-front so the failure message names the actual missing dep.
    const probe = spawnSync('bun', ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `bun not found on PATH (required to spawn the MCP server because ` +
          `it imports 'bun:sqlite'). Install via https://bun.sh and retry.`,
      );
    }
  });

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

        // Drive a small saga: workflow init + 2 event appends.
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
        // workflow init auto-emits workflow.started; then 2 explicit appends.
        expect(snap.events.length).toBeGreaterThanOrEqual(3);
        const types = snap.events.map(
          (e) => (e as Record<string, unknown>).type,
        );
        // Order is preserved: workflow.started must precede task events.
        const startedIdx = types.indexOf('workflow.started');
        const assignedIdx = types.indexOf('task.assigned');
        const progressedIdx = types.indexOf('task.progressed');
        expect(startedIdx).toBeGreaterThanOrEqual(0);
        expect(assignedIdx).toBeGreaterThan(startedIdx);
        expect(progressedIdx).toBeGreaterThan(assignedIdx);
      });
    }, 30_000);

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
          // Normalized timestamps must be the placeholder, not an ISO string.
          if ('timestamp' in obj) {
            expect(obj.timestamp).toBe('<TIMESTAMP>');
          }
          // Normalized sequences must be the placeholder, not a number.
          if ('sequence' in obj) {
            expect(obj.sequence).toBe('<SEQ>');
          }
        }
      });
    }, 30_000);
  });

  describe('replayInto', () => {
    it('replayInto_emptyTarget_appliesAllEvents', async () => {
      // Source server: drive a saga and snapshot it.
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
        // Drop from active tracker since we already terminated.
        const idx = activeClients.indexOf(sourceSpawned);
        if (idx >= 0) activeClients.splice(idx, 1);
        return captured;
      });

      // Source-side guardrail: without these, a failed source setup (workflow
      // init or event append silently broken) would leave `snap.events`
      // empty, and the target-equality assertion below would compare two
      // empty arrays — a false green. Pin the expected source shape.
      expect(snap.events.length).toBeGreaterThanOrEqual(2);
      const srcTypes = snap.events.map(
        (e) => (e as Record<string, unknown>).type,
      );
      expect(srcTypes).toContain('workflow.started');
      expect(srcTypes).toContain('task.assigned');

      // Target server: fresh hermetic env, replay into it, then snapshot.
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

    it('replayInto_idempotent_secondCallNoOp', async () => {
      // Build snapshot.
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

      // Source-side guardrail (parallel to replayInto_emptyTarget_*): block
      // the false-green where both source and target produce empty arrays.
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

        // Second replay must be a no-op.
        await replayInto(targetSpawned, snap);
        const after2 = await snapshotEventStream(targetSpawned, 'idem-feat');
        expect(after2.events.length).toBe(snap.events.length);
        expect(after2.events).toEqual(after1.events);
      });
    }, 60_000);
  });
});
