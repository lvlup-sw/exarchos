// ─── Investigation Timer ────────────────────────────────────────────────────
//
// Tracks debug investigation time budgets. Parses ISO8601 timestamps,
// calculates elapsed time, and recommends "continue" or "escalate"
// based on a configurable budget (default 15 minutes).
//
// Ported from scripts/investigation-timer.sh
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface InvestigationTimerArgs {
  readonly startedAt?: string;
  readonly stateFile?: string;
  readonly budgetMinutes?: number;
}

interface InvestigationTimerResult {
  readonly action: 'continue' | 'escalate';
  readonly elapsedMinutes: number;
  readonly remainingMinutes: number;
  readonly report: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveStartedAt(args: InvestigationTimerArgs): string | null {
  if (args.startedAt) {
    return args.startedAt;
  }

  if (args.stateFile) {
    if (!fs.existsSync(args.stateFile)) {
      return null;
    }
    const content = fs.readFileSync(args.stateFile, 'utf-8');
    const state: unknown = JSON.parse(content);
    if (
      typeof state === 'object' &&
      state !== null &&
      'investigation' in state &&
      typeof (state as Record<string, unknown>).investigation === 'object' &&
      (state as Record<string, unknown>).investigation !== null
    ) {
      const investigation = (state as { investigation: Record<string, unknown> }).investigation;
      if (typeof investigation.startedAt === 'string') {
        return investigation.startedAt;
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
): Promise<ToolResult> {
  // Resolve the startedAt timestamp
  const startedAt = resolveStartedAt(args);

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
