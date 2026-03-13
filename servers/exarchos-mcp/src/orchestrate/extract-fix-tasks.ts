// ─── Extract Fix Tasks Handler ───────────────────────────────────────────────
//
// TypeScript port of scripts/extract-fix-tasks.sh.
// Parses review findings from a workflow state file (or external review report)
// into a structured array of fix tasks with zero-padded IDs.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtractFixTasksArgs {
  readonly stateFile: string;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Handler ─────────────────────────────────────────────────────────────────

export function handleExtractFixTasks(args: ExtractFixTasksArgs): ToolResult {
  // 1. Parse state file
  const stateResult = parseJsonFile(args.stateFile, 'State file');
  if ('error' in stateResult) return stateResult.error;
  const state = stateResult.data;

  if (!isRecord(state)) {
    return {
      success: false,
      error: { code: 'PARSE_ERROR', message: `State file is not a JSON object: ${args.stateFile}` },
    };
  }

  // 2. Extract findings
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
    // Extract from state.reviews
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

  // 3. Get worktree info from tasks
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

  // 4. Fail if multiple worktrees and findings exist
  if (worktrees.length > 1 && findings.length > 0) {
    return {
      success: false,
      error: {
        code: 'AMBIGUOUS_WORKTREE',
        message: `${worktrees.length} worktrees detected but cannot deterministically map ${findings.length} findings to worktrees. Assign worktrees manually in the fix task file.`,
      },
    };
  }

  // 5. Transform findings to fix tasks
  const worktreeValue = worktrees.length === 1 ? worktrees[0].worktree : null;
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
