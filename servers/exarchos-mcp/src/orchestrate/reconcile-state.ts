// ─── Reconcile State Handler ────────────────────────────────────────────────
//
// Validates a workflow state file against git reality. Checks that the state
// file exists and is valid JSON, the phase is valid for the workflow type,
// task branches exist in git, worktrees exist on disk and in git, and
// in-progress tasks have branches assigned.
//
// Ported from scripts/reconcile-state.sh
// ────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { resolveWorkflowState } from './resolve-state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconcileStateArgs {
  readonly stateFile?: string;
  readonly featureId?: string;
  readonly eventStore?: EventStore;
  readonly repoRoot: string;
}

interface Task {
  readonly id: string;
  readonly branch?: string;
  readonly status?: string;
}

interface Worktree {
  readonly path?: string;
  readonly status?: string;
}

interface WorkflowState {
  readonly workflowType?: string;
  readonly phase?: string;
  readonly tasks?: readonly Task[];
  readonly worktrees?: Readonly<Record<string, Worktree>>;
}

// ─── Valid Phases ───────────────────────────────────────────────────────────

const VALID_PHASES: Readonly<Record<string, readonly string[]>> = {
  feature: ['ideate', 'plan', 'plan-review', 'delegate', 'review', 'synthesize', 'completed', 'cancelled', 'blocked'],
  debug: ['triage', 'investigate', 'rca', 'design', 'debug-implement', 'debug-validate', 'debug-review', 'hotfix-implement', 'hotfix-validate', 'synthesize', 'completed', 'cancelled', 'blocked'],
  refactor: ['explore', 'brief', 'polish-implement', 'polish-validate', 'polish-update-docs', 'overhaul-plan', 'overhaul-delegate', 'overhaul-review', 'overhaul-update-docs', 'synthesize', 'completed', 'cancelled', 'blocked'],
};

// ─── Check Result Accumulator ───────────────────────────────────────────────

interface CheckAccumulator {
  pass: number;
  fail: number;
  results: string[];
}

function checkPass(acc: CheckAccumulator, name: string): void {
  acc.results.push(`- **PASS**: ${name}`);
  acc.pass += 1;
}

function checkFail(acc: CheckAccumulator, name: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : '';
  acc.results.push(`- **FAIL**: ${name}${suffix}`);
  acc.fail += 1;
}

// ─── Individual Checks ─────────────────────────────────────────────────────

function checkPhaseValid(acc: CheckAccumulator, state: WorkflowState): void {
  const workflowType = state.workflowType ?? 'feature';
  const phase = state.phase ?? 'unknown';
  const validPhases = VALID_PHASES[workflowType];

  if (!validPhases) {
    checkFail(acc, 'Phase is valid', `Unknown workflow type: ${workflowType}`);
    return;
  }

  if (validPhases.includes(phase)) {
    checkPass(acc, `Phase is valid (${phase} for ${workflowType})`);
  } else {
    checkFail(acc, 'Phase is valid', `Phase '${phase}' is not valid for workflow type '${workflowType}' (valid: ${validPhases.join(', ')})`);
  }
}

function checkTaskBranches(acc: CheckAccumulator, state: WorkflowState, repoRoot: string): void {
  const tasks = state.tasks ?? [];

  if (tasks.length === 0) {
    checkPass(acc, 'Task branches exist (no tasks to check)');
    return;
  }

  const branchedTasks = tasks.filter((t) => t.branch != null && t.branch !== '');
  if (branchedTasks.length === 0) {
    checkPass(acc, 'Task branches exist (no branches to check)');
    return;
  }

  const missingBranches: string[] = [];

  for (const task of branchedTasks) {
    try {
      execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${task.branch}`], {
        stdio: 'pipe',
      });
    } catch {
      missingBranches.push(task.branch!);
    }
  }

  if (missingBranches.length === 0) {
    checkPass(acc, `Task branches exist (${branchedTasks.length} branches verified)`);
  } else {
    checkFail(acc, 'Task branches exist', `Missing branches: ${missingBranches.join(', ')}`);
  }
}

function checkWorktreesExist(acc: CheckAccumulator, state: WorkflowState, repoRoot: string): void {
  const worktrees = state.worktrees ?? {};
  const activeWorktrees = Object.values(worktrees).filter((wt) => wt.status === 'active' && wt.path);

  if (activeWorktrees.length === 0) {
    checkPass(acc, 'Worktrees exist (no worktrees to check)');
    return;
  }

  // Get git worktree list
  let gitWorktreePaths: string[] = [];
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    gitWorktreePaths = output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.replace('worktree ', ''));
  } catch {
    // If git worktree list fails, treat all as missing
  }

  const missingWorktrees: string[] = [];

  for (const wt of activeWorktrees) {
    const wtPath = wt.path!;
    if (!existsSync(wtPath)) {
      missingWorktrees.push(wtPath);
    } else if (!gitWorktreePaths.includes(wtPath)) {
      missingWorktrees.push(`${wtPath} (not a git worktree)`);
    }
  }

  if (missingWorktrees.length === 0) {
    checkPass(acc, `Worktrees exist (${activeWorktrees.length} worktrees verified)`);
  } else {
    checkFail(acc, 'Worktrees exist', `Missing worktree paths: ${missingWorktrees.join(', ')}`);
  }
}

function checkTaskStatusConsistency(acc: CheckAccumulator, state: WorkflowState): void {
  const tasks = state.tasks ?? [];

  if (tasks.length === 0) {
    checkPass(acc, 'Task status consistency (no tasks to check)');
    return;
  }

  const inconsistencies: string[] = [];

  for (const task of tasks) {
    if (task.status === 'in-progress' && (!task.branch || task.branch === '')) {
      inconsistencies.push(`Task ${task.id} is in-progress but has no branch`);
    }
  }

  if (inconsistencies.length === 0) {
    checkPass(acc, `Task status consistency (${tasks.length} tasks checked)`);
  } else {
    checkFail(acc, 'Task status consistency', inconsistencies.join('; '));
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleReconcileState(args: ReconcileStateArgs): Promise<ToolResult> {
  const { stateFile, featureId, eventStore, repoRoot } = args;

  // Resolve state via file or event store fallback
  const resolveResult = await resolveWorkflowState({ stateFile, featureId, eventStore });
  if ('error' in resolveResult) {
    return resolveResult.error;
  }

  const state = resolveResult.state as unknown as WorkflowState;

  const acc: CheckAccumulator = { pass: 0, fail: 0, results: [] };

  checkPass(acc, 'State resolved');

  // Check 2: Phase validity
  checkPhaseValid(acc, state);

  // Check 3: Task branches
  checkTaskBranches(acc, state, repoRoot);

  // Check 4: Worktrees
  checkWorktreesExist(acc, state, repoRoot);

  // Check 5: Task status consistency
  checkTaskStatusConsistency(acc, state);

  // Build markdown report
  const passed = acc.fail === 0;
  const total = acc.pass + acc.fail;
  const statusLine = passed
    ? `**Result: PASS** — State is consistent with git (${acc.pass}/${total} checks passed)`
    : `**Result: FAIL** — Discrepancies found (${acc.fail}/${total} checks failed)`;

  const report = [
    '## State Reconciliation Report',
    '',
    `**State source:** \`${stateFile ?? featureId ?? 'event-store'}\``,
    `**Repo root:** \`${repoRoot}\``,
    '',
    ...acc.results,
    '',
    '---',
    '',
    statusLine,
  ].join('\n');

  return {
    success: true,
    data: {
      passed,
      report,
      checks: { pass: acc.pass, fail: acc.fail },
    },
  };
}
