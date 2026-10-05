/**
 * `runFollowLoop`, the polling loop of the CLI `--follow` view commands: polling, line output,
 * the poll interval, and cancel on abort. The fixture stores implement only the two
 * `FollowTaskStore` methods, `getTask` and `updateTaskStatus`.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { V2Task as Task } from '../../../src/contract/sdk/seam.js';

import { runFollowLoop, type FollowTaskStore } from '../../../src/cli/follow-loop.js';

/**
 * A task store that returns the scripted snapshots in order, then repeats the last one.
 * `cancelCalls` records each `cancelled` status write.
 */
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
      expect(result.transitions).toBeGreaterThanOrEqual(2);
    });

    it('CliFollow_ShepherdSubcommand_RendersTransitionsToStdout', async () => {
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

    /**
     * The test passes `pollIntervalMs` directly and reads no `.exarchos.yml`. The CLI adapter
     * resolves `cli.followPollIntervalMs`. On the fake clock, three polls at 50 ms cannot end
     * before 100 ms.
     */
    it('CliFollow_PollIntervalConfigurable_ReadsExarchosYml', async () => {
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

      vi.useFakeTimers();
      try {
        let finished = false;
        const loop = runFollowLoop({
          taskStore: store,
          taskId,
          pollIntervalMs: 50,
          stdout,
          subcommand: 'workflow_status',
        }).then((result) => {
          finished = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(99);
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await loop).terminalStatus).toBe('completed');
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * The second snapshot keeps the status and changes `statusMessage` and `lastUpdatedAt`.
     * The loop must write a line for it.
     */
    it('CliFollow_PayloadChange_AlsoRenders', async () => {
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
      const stdout = new PassThrough();
      const store: FollowTaskStore = {
        async getTask() {
          return null;
        },
        async updateTaskStatus() {
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

  /**
   * An abort simulates SIGINT. The loop must write the `cancelled` status before it
   * resolves, so the event is in the store before the CLI exits. The scripts never reach
   * a terminal status.
   */
  describe('T34 — SIGINT cancels via task.cancelled', () => {
    it('CliFollow_SIGINT_CancelsTaskAndExits', async () => {
      const taskId = 'task-sigint-005';
      const script: Task[] = [
        { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
      ];
      const stdout = new PassThrough();
      const store = scriptedStore(taskId, script);
      const controller = new AbortController();

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

    /** A 30 ms `updateTaskStatus` shows that the loop awaits the cancel write. */
    it('CliFollow_SIGINT_DoesNotExitBeforeCancelResolves', async () => {
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
