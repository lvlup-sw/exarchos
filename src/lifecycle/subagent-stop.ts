/**
 * SubagentStop observer. It records the output tokens of a subagent on the feature stream of its teammate.
 * The `team_performance` and `delegation_timeline` views read these `subagent.tokens_used` events.
 *
 * No Claude Code hook payload carries per-subagent token usage. The only source is the subagent transcript.
 * SubagentStop is the only lifecycle hook that a subagent fires.
 *
 * The hook only observes and fails open. It never blocks the subagent, and every failure returns `{ continue: true }`.
 * Runtimes without this hook produce no events, and the views fold the events that exist.
 *
 * Known gap: attribution works only for Exarchos agent-team worktree dispatch.
 * Agent-tool native isolation gives each agent a `.claude/worktrees/agent-<id>` cwd that the orchestrator cannot declare first.
 * Those dispatches produce no event.
 */

import { z } from 'zod';
import type { CommandResult } from './types.js';
import { EventStore } from '../events/store.js';
import { parseTranscript } from '../projections/session/transcript-parser.js';
import type { SessionSummaryEvent } from '../projections/session/types.js';

/**
 * SubagentStop hook payload. Only `agent_id` and `agent_transcript_path` are required. The other fields help attribution.
 * `.passthrough()` accepts extra hook fields.
 */
const SubagentStopInputSchema = z
  .object({
    agent_id: z.string().min(1),
    agent_transcript_path: z.string().min(1),
    cwd: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    agent_type: z.string().min(1).optional(),
  })
  .passthrough();

/** Resolved teammate identity + the feature stream the atom belongs on. */
export interface ResolvedTeammate {
  readonly featureId: string;
  readonly teammateName: string;
  readonly taskId?: string;
}

/**
 * Finds the teammate and feature stream whose dispatched `worktreePath` equals `cwd`.
 * It scans every stream for `team.task.assigned` and `team.teammate.dispatched` events, and returns the latest match.
 * The latest match wins because a later feature can use the same worktree path again.
 * A later timestamp wins, then a higher sequence, then a match with a `taskId`.
 * It returns null when nothing matches. A subagent without its own worktree shares the parent `cwd`, so it matches nothing.
 */
export async function resolveTeammateByWorktree(
  eventStore: EventStore,
  cwd: string,
): Promise<ResolvedTeammate | null> {
  interface Candidate {
    readonly featureId: string;
    readonly teammateName: string;
    readonly taskId?: string;
    readonly timestamp: string;
    readonly sequence: number;
  }
  const candidates: Candidate[] = [];

  for (const streamId of eventStore.listStreams()) {
    const assigned = await eventStore.query(streamId, { type: 'team.task.assigned' });
    for (const e of assigned) {
      const d = e.data as { worktreePath?: unknown; teammateName?: string; taskId?: string } | undefined;
      if (d?.worktreePath === cwd && d.teammateName) {
        candidates.push({
          featureId: streamId,
          teammateName: d.teammateName,
          ...(d.taskId !== undefined ? { taskId: d.taskId } : {}),
          timestamp: e.timestamp,
          sequence: e.sequence,
        });
      }
    }

    const dispatched = await eventStore.query(streamId, { type: 'team.teammate.dispatched' });
    for (const e of dispatched) {
      const d = e.data as { worktreePath?: unknown; teammateName?: string; assignedTaskIds?: string[] } | undefined;
      if (d?.worktreePath === cwd && d.teammateName) {
        const firstTask = d.assignedTaskIds?.[0];
        candidates.push({
          featureId: streamId,
          teammateName: d.teammateName,
          ...(firstTask !== undefined ? { taskId: firstTask } : {}),
          timestamp: e.timestamp,
          sequence: e.sequence,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  const isBetter = (c: Candidate, b: Candidate): boolean => {
    if (c.timestamp !== b.timestamp) return c.timestamp > b.timestamp;
    if (c.sequence !== b.sequence) return c.sequence > b.sequence;
    return c.taskId !== undefined && b.taskId === undefined;
  };
  const chosen = candidates.reduce((best, c) => (isBetter(c, best) ? c : best));

  return chosen.taskId !== undefined
    ? { featureId: chosen.featureId, teammateName: chosen.teammateName, taskId: chosen.taskId }
    : { featureId: chosen.featureId, teammateName: chosen.teammateName };
}

/**
 * Default token source. It sums the output tokens of the subagent transcript.
 * It returns null when the transcript cannot be parsed, and 0 when the transcript has no summary.
 */
async function defaultReadTranscriptOutputTokens(
  transcriptPath: string,
  sessionId: string,
): Promise<number | null> {
  let parsed;
  try {
    parsed = await parseTranscript(transcriptPath, { sessionId });
  } catch {
    return null;
  }
  const summary = parsed.find((e): e is SessionSummaryEvent => e.t === 'summary');
  return summary ? summary.tokTotal.out : 0;
}

/** Injectable seams for unit testing (defaults wire the real store + parser). */
export interface SubagentStopDeps {
  readonly eventStore?: EventStore;
  readonly readTranscriptOutputTokens?: (
    transcriptPath: string,
    sessionId: string,
  ) => Promise<number | null>;
}

/**
 * Handles the `subagent-stop` hook command. It always returns `{ continue: true }`.
 * It appends one `subagent.tokens_used` event when the count is above zero and `cwd` matches a teammate worktree.
 * A zero-token run has no usage to record, and the `team.*` events already record the run.
 * The idempotency key `subagent-tokens:<agentId>` drops a retry of the same stop.
 *
 * Expected stdin shape (Claude Code SubagentStop):
 * ```json
 * { "agent_id": "...", "agent_type": "...", "agent_transcript_path": "...",
 *   "cwd": "...", "session_id": "..." }
 * ```
 */
export async function handleSubagentStop(
  input: Record<string, unknown>,
  stateDir: string,
  deps: SubagentStopDeps = {},
): Promise<CommandResult> {
  const ok: CommandResult = { continue: true };

  const parsed = SubagentStopInputSchema.safeParse(input);
  if (!parsed.success) return ok;
  const {
    agent_id: agentId,
    agent_transcript_path: transcriptPath,
    cwd,
    session_id: sessionId,
    agent_type: agentType,
  } = parsed.data;

  const readTokens = deps.readTranscriptOutputTokens ?? defaultReadTranscriptOutputTokens;
  let outputTokens: number | null;
  try {
    outputTokens = await readTokens(transcriptPath, sessionId ?? agentId);
  } catch {
    return ok;
  }
  if (outputTokens === null) return ok;
  if (outputTokens === 0) return ok;

  try {
    const eventStore = deps.eventStore ?? new EventStore(stateDir);
    if (!deps.eventStore) await eventStore.initialize();

    if (!cwd) return ok;
    const correlation = await resolveTeammateByWorktree(eventStore, cwd);
    if (!correlation) return ok;

    await eventStore.append(
      correlation.featureId,
      {
        type: 'subagent.tokens_used',
        data: {
          agentId,
          outputTokens,
          teammateName: correlation.teammateName,
          ...(correlation.taskId !== undefined ? { taskId: correlation.taskId } : {}),
          ...(agentType ? { agentType } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(cwd ? { cwd } : {}),
        },
      },
      { idempotencyKey: `subagent-tokens:${agentId}` },
    );
  } catch {
    return ok;
  }

  return ok;
}
