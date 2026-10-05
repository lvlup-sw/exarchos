/**
 * Parses review findings from a workflow state, or from a review report, into
 * fix tasks with zero-padded ids.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveWorkflowState } from '../resolve-state.js';

interface ExtractFixTasksArgs {
  /**
   * An optional state file path. With `featureId` and `eventStore`, the state
   * comes from the event-store projection, and the handler only checks that an
   * existing file parses. Without them, the handler reads the state from this file.
   */
  readonly stateFile?: string;
  readonly featureId?: string;
  readonly eventStore?: EventStore;
  readonly reviewReport?: string;
  readonly repoRoot?: string;
}

interface FixTask {
  readonly id: string;
  readonly file: string;
  readonly line: number | null;
  readonly worktree: string | null;
  readonly description: string;
  readonly severity: string;
}

interface Finding {
  readonly file: string;
  readonly line?: number;
  readonly description: string;
  readonly severity?: string;
}

interface WorktreeInfo {
  readonly worktree: string;
  readonly branch: string;
}

function padId(n: number): string {
  return String(n).padStart(3, '0');
}

function parseJsonFile(path: string, label: string): { data: unknown } | { error: ToolResult } {
  if (!existsSync(path)) {
    return {
      error: {
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: `${label} not found: ${path}` },
      },
    };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    return { data: JSON.parse(raw) as unknown };
  } catch {
    return {
      error: {
        success: false,
        error: { code: 'PARSE_ERROR', message: `Invalid JSON in ${label}: ${path}` },
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFindings(obj: unknown): Finding[] {
  if (!Array.isArray(obj)) return [];
  const findings: Finding[] = [];
  for (const item of obj) {
    if (isRecord(item) && typeof item['file'] === 'string' && typeof item['description'] === 'string') {
      findings.push({
        file: item['file'],
        description: item['description'],
        ...(typeof item['line'] === 'number' ? { line: item['line'] } : {}),
        ...(typeof item['severity'] === 'string' ? { severity: item['severity'] } : {}),
      });
    }
  }
  return findings;
}

/**
 * Builds one fix task for each review finding.
 *
 * Findings come from `reviewReport` when it is set, and from `state.reviews`
 * when it is not. The handler parses an explicit `stateFile` itself, so the
 * resolver cannot hide a FILE_NOT_FOUND or PARSE_ERROR. With an event-store
 * fallback, a missing `stateFile` is not an error. When the tasks name more
 * than one worktree and findings exist, the handler returns AMBIGUOUS_WORKTREE.
 */
export async function handleExtractFixTasks(args: ExtractFixTasksArgs): Promise<ToolResult> {
  if (!args.stateFile && !(args.featureId && args.eventStore)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide stateFile, or featureId + eventStore for fileless resolution',
      },
    };
  }

  const hasEventFallback = Boolean(args.featureId && args.eventStore);
  if (args.stateFile && (!hasEventFallback || existsSync(args.stateFile))) {
    const fileResult = parseJsonFile(args.stateFile, 'State file');
    if ('error' in fileResult) return fileResult.error;
  }

  const resolved = await resolveWorkflowState({
    stateFile: args.stateFile,
    featureId: args.featureId,
    eventStore: args.eventStore,
  });
  if ('error' in resolved) return resolved.error;
  const state = resolved.state;

  if (!isRecord(state)) {
    return {
      success: false,
      error: { code: 'PARSE_ERROR', message: `Resolved state is not a JSON object: ${args.stateFile ?? args.featureId}` },
    };
  }

  let findings: Finding[];

  if (args.reviewReport) {
    const reportResult = parseJsonFile(args.reviewReport, 'Review report');
    if ('error' in reportResult) return reportResult.error;
    const report = reportResult.data;

    if (!isRecord(report)) {
      return {
        success: false,
        error: { code: 'PARSE_ERROR', message: `Review report is not a JSON object: ${args.reviewReport}` },
      };
    }

    findings = extractFindings(Array.isArray(report['findings']) ? report['findings'] : []);
  } else {
    findings = [];
    const reviews = state['reviews'];
    if (isRecord(reviews)) {
      for (const reviewEntry of Object.values(reviews)) {
        if (isRecord(reviewEntry) && Array.isArray(reviewEntry['findings'])) {
          findings.push(...extractFindings(reviewEntry['findings']));
        }
      }
    }
  }

  const worktrees: WorktreeInfo[] = [];
  const seenWorktrees = new Set<string>();
  if (Array.isArray(state['tasks'])) {
    for (const task of state['tasks']) {
      if (isRecord(task) && typeof task['worktree'] === 'string') {
        const wt = task['worktree'];
        if (!seenWorktrees.has(wt)) {
          seenWorktrees.add(wt);
          worktrees.push({
            worktree: wt,
            branch: typeof task['branch'] === 'string' ? task['branch'] : 'unknown',
          });
        }
      }
    }
  }

  if (worktrees.length > 1 && findings.length > 0) {
    return {
      success: false,
      error: {
        code: 'AMBIGUOUS_WORKTREE',
        message: `${worktrees.length} worktrees detected but cannot deterministically map ${findings.length} findings to worktrees. Assign worktrees manually in the fix task file.`,
      },
    };
  }

  const worktreeValue = worktrees.length === 1 ? (worktrees[0]?.worktree ?? null) : null;
  const tasks: FixTask[] = findings.map((finding, index) => ({
    id: `fix-${padId(index + 1)}`,
    file: finding.file,
    line: finding.line ?? null,
    worktree: worktreeValue,
    description: finding.description,
    severity: finding.severity ?? 'MEDIUM',
  }));

  return {
    success: true,
    data: { tasks, count: tasks.length },
  };
}
