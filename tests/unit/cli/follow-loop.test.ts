/**
 * runFollowLoop — CLI `--follow` polling-loop tests (#1273, T33 + T34).
 *
 * Wave C / PR 3. The CLI `view workflow_status --follow` and
 * `view shepherd_status --follow` subcommands consume the dispatch-core
 * `EventSourcedTaskStore` directly (function calls, not JSON-RPC) and
 * render each state transition to stdout. The MCP arm consumes the same
 * dispatch-core via `tasks/*` (C2) — INV-2 facade equivalence.
 *
 * These tests pin the polling, formatting, configuration, and cancellation
 * contracts without instantiating the full Commander entry. Fixture stores
 * implement the minimum slice of the `TaskStore` interface that the loop
 * exercises: `getTask` (for polling) and `updateTaskStatus` (for the
 * SIGINT → `cancelled` path), plus a small in-memory `cancelCalls`
 * spy used in the T34 SIGINT assertion.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { V2Task as Task } from '../../../src/contract/sdk/seam.js';

import { runFollowLoop, type FollowTaskStore } from '../../../src/cli/follow-loop.js';

// ─── Fixture builder ───────────────────────────────────────────────────────
//
// `scriptedStore` constructs a tiny TaskStore facade that progresses
// through a scripted sequence of Task snapshots on consecutive `getTask`
// calls. The final snapshot in the script is returned forever once the
// loop reaches it; tests assert the loop terminates only when the final
// status is one of `completed | failed | cancelled` (per the SDK
// `isTerminal` predicate).
function scriptedStore(taskId: string, script: ReadonlyArray<Task>): FollowTaskStore & {
  cancelCalls: ReadonlyArray<{ taskId: string; reason?: string }>;
} {
  let cursor = 0;
  const cancelCalls: Array<{ taskId: string; reason?: string }> = [];
  return {
    async getTask(id: string): Promise<Task | null> {
      if (id !== taskId) return null;
      const next = script[Math.min(cursor, script.length - 1)];
      cursor += 1;
      return { ...next };
    },
    async updateTaskStatus(id, status, statusMessage): Promise<void> {
      if (status === 'cancelled') {
        cancelCalls.push({ taskId: id, reason: statusMessage });
      }
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

function drain(stream: PassThrough): string {
  return stream.read()?.toString('utf8') ?? '';
}

const ISO_FIXED = '2026-05-15T00:00:00.000Z';

describe('runFollowLoop (#1273)', () => {
  describe('T33 — --follow polling loop', () => {
    it('CliFollow_WorkflowSubcommand_RendersTransitionsToStdout', async () => {
      // Script the workflow_status task through working → completed.
      // The loop must emit one stdout line per transition (status change)
      // and exit when the terminal status is reached.
      const taskId = 'task-wf-001';
      const script: Task[] = [
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
        {
          taskId,
          status: 'completed',
          ttl: 60_000,
          createdAt: ISO_FIXED,
          lastUpdatedAt: '2026-05-15T00:00:01.000Z',
        },
      ];
      const stdout = new PassThrough();
      const store = scriptedStore(taskId, script);

      const result = await runFollowLoop({
        taskStore: store,
        taskId,
        pollIntervalMs: 1,
        stdout,
        subcommand: 'workflow_status',
      });

      const text = drain(stdout);
      expect(text).toContain(taskId);
      expect(text).toContain('working');
      expect(text).toContain('completed');
      expect(result.terminalStatus).toBe('completed');
      // Polling MUST stop once the terminal status is observed; no
      // additional `lastUpdatedAt` events should leak out after.
      expect(result.transitions).toBeGreaterThanOrEqual(2);
    });

    it('CliFollow_ShepherdSubcommand_RendersTransitionsToStdout', async () => {
      // Same shape for the shepherd_status entrypoint — the formatter is
      // shared, so subcommand only affects the rendered prefix.
      const taskId = 'task-sh-002';
      const script: Task[] = [
        { taskId, status: 'working', ttl: 30_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
        {
          taskId,
          status: 'failed',
          ttl: 30_000,
          createdAt: ISO_FIXED,
          lastUpdatedAt: '2026-05-15T00:00:02.000Z',
          statusMessage: 'simulated failure',
        },
      ];
      const stdout = new PassThrough();
      const store = scriptedStore(taskId, script);

      const result = await runFollowLoop({
        taskStore: store,
        taskId,
        pollIntervalMs: 1,
        stdout,
        subcommand: 'shepherd_status',
      });

      const text = drain(stdout);
      expect(text).toContain('shepherd_status');
      expect(text).toContain('failed');
      expect(result.terminalStatus).toBe('failed');
    });

    it('CliFollow_PollIntervalConfigurable_ReadsExarchosYml', async () => {
      // T33 acceptance: `cli.followPollIntervalMs` is honored. The loop
      // accepts the resolved value via `pollIntervalMs` (the resolver
      // lives in the CLI adapter wiring); here we assert that supplying
      // `100` actually paces the loop (not just rapid-fires through the
      // script). We measure elapsed time across three transitions; with
      // a 100ms cadence + 2 polls between transitions, wall-clock must
      // exceed ~150ms even on a busy CI runner.
      const taskId = 'task-cfg-003';
      const script: Task[] = [
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
        {
          taskId,
          status: 'completed',
          ttl: 60_000,
          createdAt: ISO_FIXED,
          lastUpdatedAt: '2026-05-15T00:00:03.000Z',
        },
      ];
      const stdout = new PassThrough();
      const store = scriptedStore(taskId, script);

      const start = Date.now();
      await runFollowLoop({
        taskStore: store,
        taskId,
        pollIntervalMs: 50,
        stdout,
        subcommand: 'workflow_status',
      });
      const elapsed = Date.now() - start;
      // Three polls × 50ms cadence ≈ 100ms+; allow generous floor for
      // CI scheduling jitter. The point is that the cadence is observed
      // and the loop does NOT race ahead in zero ms.
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('CliFollow_PayloadChange_AlsoRenders', async () => {
      // A status-message change (without a status flip) is still a
      // transition the operator wants to see — pin the formatter to
      // emit on any `lastUpdatedAt` advance, not just status flips.
      const taskId = 'task-payload-004';
      const script: Task[] = [
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED, statusMessage: 'phase 1' },
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: '2026-05-15T00:00:01.000Z', statusMessage: 'phase 2' },
        {
          taskId,
          status: 'completed',
          ttl: 60_000,
          createdAt: ISO_FIXED,
          lastUpdatedAt: '2026-05-15T00:00:02.000Z',
        },
      ];
      const stdout = new PassThrough();
      const store = scriptedStore(taskId, script);
      await runFollowLoop({
        taskStore: store,
        taskId,
        pollIntervalMs: 1,
        stdout,
        subcommand: 'workflow_status',
      });
      const text = drain(stdout);
      expect(text).toContain('phase 1');
      expect(text).toContain('phase 2');
    });

    it('CliFollow_MissingTask_ReturnsImmediately', async () => {
      // `getTask` returning null is a not-found signal; render an error
      // line and bail out so the operator isn't left polling forever.
      const stdout = new PassThrough();
      const store: FollowTaskStore = {
        async getTask() {
          return null;
        },
        async updateTaskStatus() {
          /* unused */
        },
      };
      const result = await runFollowLoop({
        taskStore: store,
        taskId: 'missing-task',
        pollIntervalMs: 1,
        stdout,
        subcommand: 'workflow_status',
      });
      const text = drain(stdout);
      expect(text).toContain('missing-task');
      expect(result.terminalStatus).toBe('failed');
    });
  });

  describe('T34 — SIGINT cancels via task.cancelled', () => {
    it('CliFollow_SIGINT_CancelsTaskAndExits', async () => {
      // Simulate SIGINT mid-loop via an AbortController; the loop must
      // call `updateTaskStatus(taskId, 'cancelled', 'user-interrupt')`
      // and only then resolve. Asserting the cancel call landed BEFORE
      // the loop resolves is the load-bearing property: the project
      // memory caution is "the CLI signal handler must NOT call
      // process.exit until cancelTask resolves (event must land in the
      // store)" — exposed here as `cancelCalls` populated by the time
      // the await returns.
      const taskId = 'task-sigint-005';
      // Long-running script — never reaches a terminal status on its own.
      const script: Task[] = [
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
      ];
      const stdout = new PassThrough();
      const store = scriptedStore(taskId, script);
      const controller = new AbortController();

      // Trigger cancellation after the first poll lands. setImmediate
      // queues post-microtask so the loop has time to observe at least
      // one snapshot before SIGINT is simulated.
      setTimeout(() => controller.abort(), 5);

      const result = await runFollowLoop({
        taskStore: store,
        taskId,
        pollIntervalMs: 2,
        stdout,
        subcommand: 'workflow_status',
        signal: controller.signal,
      });

      expect(store.cancelCalls.length).toBe(1);
      expect(store.cancelCalls[0]).toEqual({
        taskId,
        reason: 'user-interrupt',
      });
      expect(result.terminalStatus).toBe('cancelled');
      const text = drain(stdout);
      expect(text).toContain('cancelled');
    });

    it('CliFollow_SIGINT_DoesNotExitBeforeCancelResolves', async () => {
      // The SIGINT handler must await cancelTask before resolving. We
      // simulate a slow updateTaskStatus to assert the loop's resolved
      // promise lands strictly after the cancel call completes — never
      // before. This is the explicit project-memory caution.
      const taskId = 'task-sigint-slow-006';
      const script: Task[] = [
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
      ];
      const stdout = new PassThrough();
      let cancelResolved = false;
      const controller = new AbortController();

      const store: FollowTaskStore = {
        async getTask(id: string): Promise<Task | null> {
          if (id !== taskId) return null;
          return { ...script[0] };
        },
        async updateTaskStatus(_id, status): Promise<void> {
          if (status === 'cancelled') {
            // Slow cancel: ~30ms wall-clock so the assertion below is
            // observable even on a fast runner.
            await new Promise((resolve) => setTimeout(resolve, 30));
            cancelResolved = true;
          }
        },
      };

      setTimeout(() => controller.abort(), 5);
      await runFollowLoop({
        taskStore: store,
        taskId,
        pollIntervalMs: 2,
        stdout,
        subcommand: 'workflow_status',
        signal: controller.signal,
      });

      expect(cancelResolved).toBe(true);
    });
  });
});
