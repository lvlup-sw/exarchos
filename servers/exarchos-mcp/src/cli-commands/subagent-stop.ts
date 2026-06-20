// ─── SubagentStop Observer — per-subagent token telemetry (#1525 W2 Half 1) ──
//
// Restores the SubagentStop observer removed in #1476, now with a real purpose:
// attribute LLM output-token usage to the teammate that spent it, so the
// `team_performance` / `delegation_timeline` views can report it (epic #1515's
// token-reduction acceptance gate).
//
// Why a hook, and why here (W2-1 finding): Claude Code exposes per-subagent token
// usage NOWHERE in any hook payload — the only source is the subagent's OWN
// transcript JSONL (`agent_transcript_path`), and SubagentStop is a subagent's
// only lifecycle hook (subagents share the parent session_id and never fire
// SessionStart/End). So this handler: (1) sums output tokens from the subagent's
// own transcript at its stop boundary (NOT the forbidden parent-session-end
// re-parse), (2) resolves the teammate identity by matching the subagent `cwd` to
// a dispatched worktree on a feature stream, and (3) appends one correctly-sourced
// `subagent.tokens_used` atom to that feature stream. The fold (team-performance /
// delegation-timeline) then stays a clean single-stream left-fold (INV-1).
//
// Observe-only / fail-open (ADR docs/adrs/2026-05-24-hook-layer-observe-only.md):
// it never returns a policy `error` and never blocks the subagent. Any missing
// input, unreadable transcript, unresolved worktree, or store failure degrades
// silently to `{ continue: true }`. INV-4: token capture is a Claude-Code-specific
// seam; runtimes without this hook simply produce no atoms and the views fold
// what exists (empty per-teammate metrics, never an error).

import { z } from 'zod';
import type { CommandResult } from './types.js';
import { EventStore } from '../event-store/store.js';
import { parseTranscript } from '../session/transcript-parser.js';
import type { SessionSummaryEvent } from '../session/types.js';

// Input contract for the SubagentStop hook payload. Only `agent_id` +
// `agent_transcript_path` are load-bearing; the rest aid attribution. Parsed
// with safeParse so a malformed payload degrades fail-open (never throws, never
// blocks). `.passthrough()` tolerates extra hook fields without rejecting.
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
 * Resolve a teammate (and the feature stream) by matching a subagent's working
 * directory to a dispatched worktree. Scans every stream for `team.task.assigned`
 * (preferred — carries `taskId`) or `team.teammate.dispatched` events whose
 * `worktreePath` equals `cwd`, and returns the MOST RECENT match by
 * (timestamp, sequence). Latest-wins matters because a worktree path can be
 * reused across features over time, so the first match is not necessarily the
 * current owner — taking the first would misattribute tokens to a stale stream
 * (#1560 review). Returns null when nothing matches — the caller treats that as
 * "cannot attribute" and skips the emission.
 *
 * Clean attribution requires worktree-isolated dispatch (so `cwd` is unique to the
 * teammate). A non-isolated subagent shares the parent `cwd`, which matches no
 * dispatched worktree → null → no atom (INV-4 graceful degradation).
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

  // Later timestamp wins; ties break by sequence, then prefer a candidate that
  // carries a taskId (team.task.assigned) over one that does not.
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

/** Default token source: sum `output_tokens` across the subagent's own transcript. */
async function defaultReadTranscriptOutputTokens(
  transcriptPath: string,
  sessionId: string,
): Promise<number | null> {
  let parsed;
  try {
    parsed = await parseTranscript(transcriptPath, { sessionId });
  } catch {
    return null; // missing / unreadable transcript → fail-open
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
 * Handle the `subagent-stop` hook command.
 *
 * Expected stdin shape (Claude Code SubagentStop; only `agent_id` +
 * `agent_transcript_path` are load-bearing):
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
  // Observe-only: a single fail-open return shape. Never block the subagent.
  const ok: CommandResult = { continue: true };

  // Validate the hook payload at the boundary. A malformed payload (missing the
  // load-bearing agent_id / transcript path) degrades fail-open.
  const parsed = SubagentStopInputSchema.safeParse(input);
  if (!parsed.success) return ok;
  const {
    agent_id: agentId,
    agent_transcript_path: transcriptPath,
    cwd,
    session_id: sessionId,
    agent_type: agentType,
  } = parsed.data;

  // 1. Sum the subagent's own output tokens.
  const readTokens = deps.readTranscriptOutputTokens ?? defaultReadTranscriptOutputTokens;
  let outputTokens: number | null;
  try {
    outputTokens = await readTokens(transcriptPath, sessionId ?? agentId);
  } catch {
    return ok;
  }
  if (outputTokens === null) return ok;
  // A zero-token run carries no usage signal to attribute. The run itself is
  // already recorded by team.teammate.dispatched / team.task.completed, so
  // skipping the atom keeps the token metrics clean without losing provenance
  // (#1560 review).
  if (outputTokens === 0) return ok;

  // 2. Resolve teammate identity + target feature stream by worktree↔cwd.
  // 3. Append the correctly-sourced atom. Any failure → fail-open.
  try {
    const eventStore = deps.eventStore ?? new EventStore(stateDir);
    if (!deps.eventStore) await eventStore.initialize();

    if (!cwd) return ok; // no cwd → no worktree to match → cannot attribute
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
      // Dedupe retries of the same subagent stop (idempotency cache is per-stream).
      { idempotencyKey: `subagent-tokens:${agentId}` },
    );
  } catch {
    return ok;
  }

  return ok;
}
