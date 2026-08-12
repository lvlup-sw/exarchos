// ─── Select Debug Track Composite Action ─────────────────────────────────────
//
// Pure TypeScript debug track selection — deterministic decision tree that
// selects between HOTFIX and THOROUGH debug tracks based on urgency level
// and whether the root cause is known. No bash script dependency.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../events/store.js';
import { resolveWorkflowState } from './resolve-state.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Argument & Result Types ────────────────────────────────────────────────

interface SelectDebugTrackArgs {
  readonly urgency?: string;
  readonly rootCauseKnown?: boolean | string;
  readonly stateFile?: string;
  readonly featureId?: string;
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
  eventStore?: EventStore,
): Promise<ToolResult> {
  let urgency = args.urgency;
  let rootCauseKnownRaw = args.rootCauseKnown;

  const needsStateResolution = urgency === undefined || rootCauseKnownRaw === undefined;
  const hasStateSource = !!args.stateFile || !!(args.featureId && eventStore);

  // Resolve urgency/rootCauseKnown from workflow state when direct args are
  // missing. INV-1: the event store is the sole source of truth; the
  // `.state.json` file is a derived stamp that may be absent for MCP-only
  // workflows. We still validate an explicit stateFile path for containment.
  if (needsStateResolution && hasStateSource) {
    // Path-containment guard applies only to an explicit file path; the
    // event-store path has no filesystem location to validate.
    if (args.stateFile) {
      const resolvedStateFile = path.resolve(args.stateFile);
      const resolvedStateDir = path.resolve(_stateDir);
      if (!resolvedStateFile.startsWith(resolvedStateDir + path.sep) && resolvedStateFile !== resolvedStateDir) {
        return {
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: `State file must be within the state directory: ${resolvedStateDir}`,
          },
        };
      }

      // Preserve the historical "file given but missing" error.
      if (!fs.existsSync(args.stateFile) && !(args.featureId && eventStore)) {
        return {
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: `State file not found: ${args.stateFile}`,
          },
        };
      }
    }

    const resolved = await resolveWorkflowState({
      stateFile: args.stateFile,
      featureId: args.featureId,
      eventStore,
    });
    if ('error' in resolved) {
      return {
        success: false,
        error: {
          code: 'STATE_READ_ERROR',
          message: resolved.error.error?.message ?? 'Failed to resolve workflow state',
        },
      };
    }

    const state = resolved.state as {
      urgency?: { level?: string };
      investigation?: { rootCauseKnown?: boolean | string };
    };

    if (urgency === undefined) {
      urgency = state.urgency?.level;
    }
    if (rootCauseKnownRaw === undefined) {
      rootCauseKnownRaw = state.investigation?.rootCauseKnown;
    }

    if (!urgency) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'No urgency.level found in state',
        },
      };
    }

    if (rootCauseKnownRaw === undefined) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'No investigation.rootCauseKnown found in state',
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
