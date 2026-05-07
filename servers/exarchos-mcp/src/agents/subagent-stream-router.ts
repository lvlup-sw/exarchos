import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AtomicAppender } from '../event-store/atomic-appender.js';

/**
 * SubagentStreamRouter — primitive for v2.9 bug cluster (#1224).
 *
 * Subagents in isolated worktrees emit `task.completed` events to their child
 * stream. The team coordinator (which runs in the parent / main worktree)
 * historically tracked completion via an in-memory accumulator and emitted
 * `team.disbanded` with that accumulated count — without ever propagating the
 * underlying `task.completed` events to the parent stream. The parent's
 * projection then saw a `team.disbanded` claim with no supporting events;
 * the all-tasks-complete guard (#1225) signed off on a workflow that wasn't
 * actually done.
 *
 * This router replaces that double bookkeeping with two operations that both
 * route through `AtomicAppender` on the parent stream:
 *
 *   - `onTaskCompleted` — emit a parent-stream `task.completed` event keyed
 *     by `<childStreamId>:<taskId>:task.completed`. Idempotent on replay
 *     because AtomicAppender's idempotencyKey cache is commit-on-success.
 *
 *   - `emitDisbanded` — query the parent stream for `task.completed` events
 *     scoped to this team, populate `tasksCompleted` from that count, and
 *     append `team.disbanded`. Single-writer per stream gives causal
 *     ordering (`task.completed` events have lower sequence than the
 *     subsequent `team.disbanded`) by construction, so the parent
 *     projection sees a coherent fold.
 *
 * The interface is the local analog of #1259's namespaced shared-stream
 * model — when that lands, this implementation flattens to a query over
 * `stream_id LIKE '<parent>/%'` and the parent emit on `team.disbanded`
 * remains.
 *
 * This module ships ahead of its consumer site. Wiring lands in commit C11
 * (intercepting `team.disbanded` in `handleEventAppend`); see design
 * Primitive 2 'Consumer changes' subsection.
 */

/**
 * Payload for a child-stream task completion that the router will propagate
 * to the parent stream. `teamId` is required so `emitDisbanded` can scope
 * its count to the right team — multiple teams can write `task.completed`
 * to the same parent stream.
 */
export interface TaskCompletedPayload {
  taskId: string;
  teamId: string;
  /** Optional pass-through fields; persisted on the parent-stream event. */
  acceptanceTestRef?: string;
  artifacts?: string[];
  duration?: number;
  evidence?: {
    type: 'test' | 'build' | 'typecheck' | 'manual';
    output: string;
    passed: boolean;
  };
  verified?: boolean;
  implements?: string[];
  tests?: { name: string; file: string }[];
  files?: string[];
  [k: string]: unknown;
}

/**
 * Summary fields for `team.disbanded`. `tasksCompleted` is intentionally
 * NOT part of this shape — it is computed by querying the parent stream.
 * The double-bookkeeping that produces #1224's off-by-N is the reason the
 * accumulator is removed, not just hidden.
 */
export interface DisbandedSummary {
  teamId: string;
  totalDurationMs: number;
  tasksFailed: number;
  /** Optional pass-through fields persisted on the disbanded event. */
  [k: string]: unknown;
}

/**
 * The router contract. Two operations, both of which append to the parent
 * stream via `AtomicAppender`. `tasksCompleted` is computed from the
 * parent stream at emission time, never from an accumulator.
 */
export interface SubagentStreamRouterContract {
  onTaskCompleted(
    parentStreamId: string,
    childStreamId: string,
    taskId: string,
    payload: TaskCompletedPayload,
  ): Promise<void>;
  emitDisbanded(parentStreamId: string, summary: DisbandedSummary): Promise<void>;
}

export interface SubagentStreamRouterOptions {
  /** Parent-stream appender — single writer per stream. */
  appender: AtomicAppender;
  /**
   * Directory under which `<streamId>.events.jsonl` lives. Must match the
   * `stateDir` configured on the appender so `emitDisbanded` can read the
   * same JSONL the appender writes.
   */
  stateDir: string;
}

interface PersistedEvent {
  type: string;
  sequence: number;
  data?: { teamId?: string; taskId?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Default implementation. Stateless w.r.t. completion counts — that's the
 * whole point.
 */
export class SubagentStreamRouter implements SubagentStreamRouterContract {
  private readonly appender: AtomicAppender;
  private readonly stateDir: string;

  constructor(options: SubagentStreamRouterOptions) {
    this.appender = options.appender;
    this.stateDir = options.stateDir;
  }

  async onTaskCompleted(
    parentStreamId: string,
    childStreamId: string,
    taskId: string,
    payload: TaskCompletedPayload,
  ): Promise<void> {
    const idempotencyKey = `${childStreamId}:${taskId}:task.completed`;
    const result = await this.appender.append(
      parentStreamId,
      [
        {
          type: 'task.completed',
          data: {
            ...payload,
            taskId,
          },
          source: 'subagent-stream-router',
        },
      ],
      idempotencyKey,
    );
    if (!result.ok) {
      throw new Error(
        `SubagentStreamRouter.onTaskCompleted failed: ${result.reason}` +
          (result.cause ? ` — ${result.cause.message}` : ''),
      );
    }
  }

  async emitDisbanded(
    parentStreamId: string,
    summary: DisbandedSummary,
  ): Promise<void> {
    // Source of truth: query the parent stream for task.completed events
    // scoped to this team. NEVER use an in-memory counter — that's the
    // exact double-bookkeeping that produced #1224.
    const tasksCompleted = await this.countTaskCompletedForTeam(
      parentStreamId,
      summary.teamId,
    );

    const idempotencyKey = `${summary.teamId}:team.disbanded`;
    const result = await this.appender.append(
      parentStreamId,
      [
        {
          type: 'team.disbanded',
          data: {
            ...summary,
            tasksCompleted,
          },
          source: 'subagent-stream-router',
        },
      ],
      idempotencyKey,
    );
    if (!result.ok) {
      throw new Error(
        `SubagentStreamRouter.emitDisbanded failed: ${result.reason}` +
          (result.cause ? ` — ${result.cause.message}` : ''),
      );
    }
  }

  /**
   * Read the parent-stream JSONL and count `task.completed` events whose
   * `data.teamId` matches. Cheap (linear scan, in-memory after first read);
   * this is the seam #1259 replaces with `SELECT COUNT(*) FROM events
   * WHERE type='task.completed' AND data->>'teamId'=?`.
   */
  private async countTaskCompletedForTeam(
    parentStreamId: string,
    teamId: string,
  ): Promise<number> {
    const filePath = path.join(this.stateDir, `${parentStreamId}.events.jsonl`);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw err;
    }
    let count = 0;
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: PersistedEvent;
      try {
        parsed = JSON.parse(line) as PersistedEvent;
      } catch {
        continue; // tolerate corruption; JSONL is line-delimited
      }
      if (parsed.type === 'task.completed' && parsed.data?.teamId === teamId) {
        count += 1;
      }
    }
    return count;
  }
}

/**
 * Convenience factory for consumers who don't want to instantiate the class
 * directly. Mirrors the `AtomicAppender` constructor shape.
 */
export function createSubagentStreamRouter(
  options: SubagentStreamRouterOptions,
): SubagentStreamRouterContract {
  return new SubagentStreamRouter(options);
}
