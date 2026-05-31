// ─── Investigation Timer ────────────────────────────────────────────────────
//
// Tracks debug investigation time budgets. Parses ISO8601 timestamps,
// calculates elapsed time, and recommends "continue" or "escalate"
// based on a configurable budget (default 15 minutes).
//
// Ported from scripts/investigation-timer.sh
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { resolveWorkflowState } from './resolve-state.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface InvestigationTimerArgs {
  readonly startedAt?: string;
  readonly stateFile?: string;
  readonly featureId?: string;
  readonly budgetMinutes?: number;
}

interface InvestigationTimerResult {
  readonly action: 'continue' | 'escalate';
  readonly elapsedMinutes: number;
  readonly remainingMinutes: number;
  readonly report: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function resolveStartedAt(
  args: InvestigationTimerArgs,
  eventStore?: EventStore,
): Promise<string | null | ToolResult> {
  if (args.startedAt) {
    return args.startedAt;
  }

  // Resolve `investigation.startedAt` via the canonical resolver (file →
  // event-store fallback). INV-1: the event store is the sole source of
  // truth; the `.state.json` file is a derived stamp that may be absent for
  // MCP-only workflows.
  if (args.stateFile || (args.featureId && eventStore)) {
    const resolved = await resolveWorkflowState({
      stateFile: args.stateFile,
      featureId: args.featureId,
      eventStore,
    });
    if ('error' in resolved) {
      // No resolvable source → caller surfaces the "required" INVALID_INPUT.
      const code = resolved.error.error?.code;
      if (code === 'NO_STATE_SOURCE') {
        return null;
      }
      return {
        success: false,
        error: {
          code: 'STATE_READ_ERROR',
          message: resolved.error.error?.message ?? 'Failed to resolve workflow state',
        },
      };
    }
    const state = resolved.state;
    const investigation = state.investigation;
    if (
      typeof investigation === 'object' &&
      investigation !== null &&
      !Array.isArray(investigation)
    ) {
      const startedAt = (investigation as Record<string, unknown>).startedAt;
      if (typeof startedAt === 'string') {
        return startedAt;
      }
    }
    return null;
  }

  return null;
}

function isValidIso8601(timestamp: string): boolean {
  const parsed = Date.parse(timestamp);
  return !isNaN(parsed);
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleInvestigationTimer(
  args: InvestigationTimerArgs,
  _stateDir: string,
  eventStore?: EventStore,
): Promise<ToolResult> {
  // Resolve the startedAt timestamp
  const startedAtResult = await resolveStartedAt(args, eventStore);

  // Propagate ToolResult errors from state file parsing
  if (typeof startedAtResult === 'object' && startedAtResult !== null && 'success' in startedAtResult) {
    return startedAtResult as ToolResult;
  }

  const startedAt = startedAtResult;

  if (!startedAt) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Either startedAt or stateFile (with investigation.startedAt) is required',
      },
    };
  }

  // Validate timestamp
  if (!isValidIso8601(startedAt)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Invalid timestamp: ${startedAt} (expected ISO8601 format)`,
      },
    };
  }

  const budgetMinutes = args.budgetMinutes ?? 15;
  const startEpochMs = Date.parse(startedAt);
  const nowMs = Date.now();
  const elapsedSeconds = Math.floor((nowMs - startEpochMs) / 1000);
  const budgetSeconds = budgetMinutes * 60;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const elapsedRemainder = elapsedSeconds % 60;

  let action: 'continue' | 'escalate';
  let status: string;
  let remainingMinutes: number;

  if (elapsedSeconds <= budgetSeconds) {
    const remainingSeconds = budgetSeconds - elapsedSeconds;
    remainingMinutes = Math.floor(remainingSeconds / 60);
    const remainingRemainder = remainingSeconds % 60;
    status = `WITHIN BUDGET (${remainingMinutes}m ${remainingRemainder}s remaining)`;
    action = 'continue';
  } else {
    const overSeconds = elapsedSeconds - budgetSeconds;
    const overMinutes = Math.floor(overSeconds / 60);
    const overRemainder = overSeconds % 60;
    status = `BUDGET EXCEEDED by ${overMinutes}m ${overRemainder}s — Recommend escalating to thorough track`;
    action = 'escalate';
    remainingMinutes = 0;
  }

  // Build markdown report matching the bash script output
  const reportLines = [
    '## Investigation Timer',
    `- **Started:** ${startedAt}`,
    `- **Elapsed:** ${elapsedMinutes}m ${elapsedRemainder}s`,
    `- **Budget:** ${budgetMinutes}m`,
    `- **Status:** ${status}`,
  ];
  const report = reportLines.join('\n');

  const result: InvestigationTimerResult = {
    action,
    elapsedMinutes,
    remainingMinutes,
    report,
  };

  return { success: true, data: result };
}
