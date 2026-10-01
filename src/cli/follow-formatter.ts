/**
 * Renders Tasks `--follow` transitions for stdout. Each `--follow` subcommand uses the same line
 * format, and only the subcommand prefix differs. Both functions are pure.
 *
 *   [<subcommand>] <taskId> <status> <lastUpdatedAt>[ — <statusMessage>]\n
 *
 * Agents read the stream line by line with tools such as `grep`, so each transition is one line
 * with a stable prefix at column 0. `lastUpdatedAt` comes from the task store, so the rendered
 * timeline matches the event-store record.
 */
import type { V2Task as Task } from '../contract/sdk/seam.js';

/** The `--follow` subcommands. The union matches `VIEW_FOLLOW_ACTIONS` in `adapters/cli/cli.ts`. */
export type FollowSubcommand =
  | 'workflow_status'
  | 'shepherd_status'
  | 'pipeline'
  | 'convergence'
  | 'delegation_timeline';

export interface FollowTransition {
  readonly subcommand: FollowSubcommand;
  readonly task: Task;
}

/**
 * Render a single `FollowTransition` as a stdout line. Always returns a
 * newline-terminated string. No trailing whitespace.
 */
export function formatTransition(t: FollowTransition): string {
  const base = `[${t.subcommand}] ${t.task.taskId} ${t.task.status} ${t.task.lastUpdatedAt}`;
  return t.task.statusMessage !== undefined
    ? `${base} — ${t.task.statusMessage}\n`
    : `${base}\n`;
}

/**
 * Render an error line when the task cannot be located. Same prefix
 * shape as `formatTransition` so downstream parsers can split on the
 * subcommand bracket without a separate code path.
 */
export function formatMissingTask(subcommand: FollowSubcommand, taskId: string): string {
  return `[${subcommand}] ${taskId} not found\n`;
}
