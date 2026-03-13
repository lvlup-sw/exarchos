// ─── Select Debug Track Composite Action ─────────────────────────────────────
//
// Pure TypeScript debug track selection — deterministic decision tree that
// selects between HOTFIX and THOROUGH debug tracks based on urgency level
// and whether the root cause is known. No bash script dependency.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import * as fs from 'node:fs';

// ─── Argument & Result Types ────────────────────────────────────────────────

interface SelectDebugTrackArgs {
  readonly urgency?: string;
  readonly rootCauseKnown?: boolean | string;
  readonly stateFile?: string;
}

interface TrackSelection {
  readonly track: 'hotfix' | 'thorough';
  readonly urgency: string;
  readonly rootCauseKnown: boolean;
  readonly reasoning: string;
  readonly report: string;
}

// ─── Valid Urgency Levels ───────────────────────────────────────────────────

const VALID_URGENCY_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
type UrgencyLevel = typeof VALID_URGENCY_LEVELS[number];

function isValidUrgency(value: string): value is UrgencyLevel {
  return (VALID_URGENCY_LEVELS as readonly string[]).includes(value);
}

// ─── Root Cause Normalization ───────────────────────────────────────────────

function normalizeRootCauseKnown(value: boolean | string): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'yes';
}

// ─── Decision Tree ──────────────────────────────────────────────────────────

function selectTrack(
  urgency: UrgencyLevel,
  rootCauseKnown: boolean,
): { track: 'hotfix' | 'thorough'; reasoning: string } {
  switch (urgency) {
    case 'critical':
      return rootCauseKnown
        ? { track: 'hotfix', reasoning: 'Critical urgency with known root cause — hotfix is appropriate' }
        : { track: 'thorough', reasoning: 'Critical urgency but unknown root cause — can\'t fix what you don\'t understand' };
    case 'high':
      return rootCauseKnown
        ? { track: 'hotfix', reasoning: 'High urgency with known root cause — hotfix is appropriate' }
        : { track: 'thorough', reasoning: 'High urgency but unknown root cause — thorough investigation needed' };
    case 'medium':
      return { track: 'thorough', reasoning: 'Medium urgency — thorough track always applies for non-critical issues' };
    case 'low':
      return { track: 'thorough', reasoning: 'Low urgency — thorough track always applies for non-critical issues' };
  }
}

// ─── Report Generation ──────────────────────────────────────────────────────

function generateReport(
  urgency: string,
  rootCauseKnown: boolean,
  track: string,
  reasoning: string,
): string {
  const lines: string[] = [
    '## Debug Track Selection',
    `- **Urgency:** ${urgency}`,
    `- **Root cause known:** ${rootCauseKnown ? 'yes' : 'no'}`,
    `- **Selected track:** ${track.toUpperCase()}`,
    `- **Reasoning:** ${reasoning}`,
  ];
  return lines.join('\n');
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSelectDebugTrack(
  args: SelectDebugTrackArgs,
  _stateDir: string,
): Promise<ToolResult> {
  let urgency = args.urgency;
  let rootCauseKnownRaw = args.rootCauseKnown;

  // Resolve from state file if provided and direct args are missing
  if (args.stateFile && urgency === undefined) {
    if (!fs.existsSync(args.stateFile)) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `State file not found: ${args.stateFile}`,
        },
      };
    }

    let state: {
      urgency?: { level?: string };
      investigation?: { rootCauseKnown?: boolean | string };
    };
    try {
      const raw = fs.readFileSync(args.stateFile, 'utf-8');
      state = JSON.parse(raw) as typeof state;
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'STATE_READ_ERROR',
          message: `Failed to read or parse state file ${args.stateFile}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    urgency = state.urgency?.level;
    rootCauseKnownRaw = state.investigation?.rootCauseKnown;

    if (!urgency) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'No urgency.level found in state file',
        },
      };
    }

    if (rootCauseKnownRaw === undefined) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'No investigation.rootCauseKnown found in state file',
        },
      };
    }
  }

  // Validate required args
  if (!urgency || rootCauseKnownRaw === undefined) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Both urgency and rootCauseKnown are required (or use stateFile)',
      },
    };
  }

  // Validate urgency level
  if (!isValidUrgency(urgency)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Invalid urgency level '${urgency}' (expected: critical, high, medium, low)`,
      },
    };
  }

  const rootCauseKnown = normalizeRootCauseKnown(rootCauseKnownRaw);
  const { track, reasoning } = selectTrack(urgency, rootCauseKnown);
  const report = generateReport(urgency, rootCauseKnown, track, reasoning);

  const data: TrackSelection = {
    track,
    urgency,
    rootCauseKnown,
    reasoning,
    report,
  };

  return { success: true, data };
}
