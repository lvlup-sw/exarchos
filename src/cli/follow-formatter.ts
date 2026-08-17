/**
 * follow-formatter — render Tasks `--follow` transitions for stdout (#1273, T33).
 *
 * Wave C / PR 3. Shared between the workflow_status and shepherd_status
 * CLI subcommands so both surfaces emit byte-identical transition lines
 * (the only diff is the subcommand prefix in front of the taskId). The
 * formatter is pure: input is the observed `Task` snapshot + the
 * subcommand label, output is a single newline-terminated string.
 *
 * Format:
 *
 *   [<subcommand>] <taskId> <status> <lastUpdatedAt>[ — <statusMessage>]\n
 *
 * Rationale: agents tail this stream by piping to `head -n` / grep, so a
 * single line per transition + a stable prefix at column 0 keeps grep
 * deterministic. The `lastUpdatedAt` field is the SDK's own transition
 * timestamp (set by `EventSourcedTaskStore.storeTaskResult` /
 * `updateTaskStatus`), reused here instead of a fresh `new Date()` so
 * the rendered timeline matches the event-store record exactly.
 */
import type { V2Task as Task } from '../contract/sdk/seam.js';

/**
 * Widened in #1440 Op 1 (T7): the CLI `--follow` predicate now admits
 * three additional view actions backed by pure `ViewProjection` folds.
 * The formatter is unchanged — only the prefix bracket varies — and the
 * union is kept in lockstep with `VIEW_FOLLOW_ACTIONS` in `adapters/cli/cli.ts`.
 */
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
