// ─── Task Decomposition Composite Action ────────────────────────────────────
//
// Pure TypeScript implementation of task decomposition quality verification.
// Validates task structure, dependency DAG, and parallel safety for the
// plan->plan-review boundary (D5: Workflow Determinism).
//
// Replaces the previous bash script (`check-task-decomposition.sh`) dependency
// with inline TypeScript logic returning structured results directly.
// ────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ───────────────────────────────────────────────────────────────

interface TaskDecompositionArgs {
  readonly featureId: string;
  readonly planPath: string;
}

/** A parsed task block from a plan file. */
export interface TaskBlock {
  /** Task ID (e.g. "T-01" or "1"). */
  readonly id: string;
  /** Raw content of the task block (including the header line). */
  readonly content: string;
}

/** Result of validating a single task block's structure. */
export interface TaskStructureResult {
  readonly hasDescription: boolean;
  readonly descriptionWordCount: number;
  readonly hasFiles: boolean;
  readonly fileCount: number;
  readonly hasTests: boolean;
  readonly testCount: number;
  readonly status: 'PASS' | 'FAIL';
}

/** Result of DAG cycle detection. */
export interface DagValidationResult {
  readonly valid: boolean;
  readonly cyclePath?: string;
}

/** Input for DAG validation. */
export interface DagTask {
  readonly id: string;
  readonly deps: readonly string[];
}

/** Input for parallel safety check. */
export interface ParallelTask {
  readonly id: string;
  readonly isParallel: boolean;
  readonly files: readonly string[];
}

/** Result of parallel safety check. */
export interface ParallelSafetyResult {
  readonly safe: boolean;
  readonly conflicts: readonly string[];
}

interface TaskDecompositionResult {
  readonly passed: boolean;
  readonly wellDecomposed: number;
  readonly needsRework: number;
  readonly totalTasks: number;
  readonly dagValid: boolean;
  readonly parallelSafe: boolean;
  readonly report: string;
}

// ─── Parse Task Blocks ──────────────────────────────────────────────────

/**
 * Extract task blocks from plan markdown content.
 *
 * Each task starts with `### Task T-XX:` or `### Task N:` and ends at the
 * next `### Task` header or EOF.
 */
export function parseTaskBlocks(content: string): TaskBlock[] {
  const lines = content.split('\n');
  const blocks: TaskBlock[] = [];
  const headerPattern = /^###\s+Task\s+(T-[0-9]+|[0-9]+)/;

  let currentId: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = headerPattern.exec(line);
    if (match) {
      // Save previous block
      if (currentId !== null) {
        blocks.push({ id: currentId, content: currentLines.join('\n') });
      }
      currentId = match[1];
      currentLines = [line];
    } else if (currentId !== null) {
      currentLines.push(line);
    }
  }

  // Save last block
  if (currentId !== null) {
    blocks.push({ id: currentId, content: currentLines.join('\n') });
  }

  return blocks;
}

// ─── Validate Task Structure ────────────────────────────────────────────

/**
 * Validate a task block for description quality, file targets, and test
 * expectations.
 *
 * Description parsing:
 * - Scans for `**Description:**` inline text
 * - Continues collecting text across blank lines
 * - Stops at next field header (`**Field:**`) or section header (`###`)
 * - Counts all words in collected description text
 *
 * File detection: backtick-quoted paths like `path/to/file.ext`
 *
 * Test detection: `[RED]` markers or `Method_Scenario_Outcome` patterns
 * (PascalCase segments joined by underscores).
 */
export function validateTaskStructure(block: string): TaskStructureResult {
  const lines = block.split('\n');

  // --- Description ---
  let descText = '';
  let inDesc = false;

  for (const line of lines) {
    if (/^\*\*Description:\*\*/.test(line)) {
      // Extract inline text after **Description:**
      const inline = line.replace(/^\*\*Description:\*\*\s*/, '');
      descText = inline;
      inDesc = true;
      continue;
    }
    if (inDesc) {
      // Stop at next field header or section header
      if (/^\*\*/.test(line) || /^###/.test(line)) {
        break;
      }
      descText += ' ' + line;
    }
  }

  const descWords = descText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const descriptionWordCount = descWords.length;
  const hasDescription = descriptionWordCount > 10;

  // --- File targets ---
  const filePattern = /`[a-zA-Z0-9_./-]+\.[a-zA-Z]+`/g;
  let fileCount = 0;
  for (const line of lines) {
    const matches = line.match(filePattern);
    if (matches) {
      fileCount += matches.length;
    }
  }
  const hasFiles = fileCount > 0;

  // --- Test expectations ---
  const redPattern = /\[RED\]/g;
  const msoPattern = /[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+/g;
  let testCount = 0;
  for (const line of lines) {
    const redMatches = line.match(redPattern);
    if (redMatches) {
      testCount += redMatches.length;
    } else {
      const msoMatches = line.match(msoPattern);
      if (msoMatches) {
        testCount += msoMatches.length;
      }
    }
  }
  const hasTests = testCount > 0;

  const status = hasDescription && hasFiles && hasTests ? 'PASS' : 'FAIL';

  return {
    hasDescription,
    descriptionWordCount,
    hasFiles,
    fileCount,
    hasTests,
    testCount,
    status,
  };
}

// ─── Dependency DAG Validation ──────────────────────────────────────────

/**
 * Validate that the dependency graph among tasks is a DAG (no cycles).
 *
 * Uses iterative DFS with explicit stack tracking. Each node has three states:
 * - 0 = unvisited
 * - 1 = in-progress (on the DFS stack)
 * - 2 = done (fully explored)
 *
 * A cycle is detected when we encounter a node that is in-progress.
 */
export function validateDependencyDAG(tasks: readonly DagTask[]): DagValidationResult {
  const visitState = new Map<string, number>();
  const taskIds = new Set<string>();

  for (const task of tasks) {
    // Reject duplicate task IDs
    if (taskIds.has(task.id)) {
      return { valid: false, cyclePath: `Duplicate task ID: ${task.id}` };
    }
    visitState.set(task.id, 0);
    taskIds.add(task.id);
  }

  // Build adjacency map (task -> deps), reject unresolved references
  const depsMap = new Map<string, readonly string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!taskIds.has(dep)) {
        return { valid: false, cyclePath: `Unresolved dependency: ${task.id} depends on unknown ${dep}` };
      }
    }
    depsMap.set(task.id, task.deps);
  }

  // Iterative DFS
  for (const task of tasks) {
    if (visitState.get(task.id) !== 0) {
      continue;
    }

    // Stack entries: [node, phase] where phase is 'enter' or 'exit'
    const stack: Array<[string, 'enter' | 'exit']> = [[task.id, 'enter']];

    while (stack.length > 0) {
      const [node, phase] = stack.pop()!;

      if (phase === 'exit') {
        visitState.set(node, 2);
        continue;
      }

      const state = visitState.get(node);

      // Already fully explored
      if (state === 2) {
        continue;
      }

      // Cycle: node is in-progress (already on the DFS stack)
      if (state === 1) {
        return { valid: false, cyclePath: node };
      }

      // Mark in-progress
      visitState.set(node, 1);
      stack.push([node, 'exit']);

      // Push dependencies
      const deps = depsMap.get(node) ?? [];
      for (const dep of deps) {
        const depState = visitState.get(dep);
        if (depState === 1) {
          // Cycle found
          return { valid: false, cyclePath: `${node} \u2192 ${dep}` };
        }
        if (depState === 0) {
          stack.push([dep, 'enter']);
        }
      }
    }
  }

  return { valid: true };
}

// ─── Parallel Safety Check ──────────────────────────────────────────────

/**
 * Check for file conflicts between parallelizable tasks.
 *
 * Compares file lists between all pairs of tasks marked as parallel,
 * reporting any overlapping files.
 */
export function checkParallelSafety(tasks: readonly ParallelTask[]): ParallelSafetyResult {
  const parallelTasks = tasks.filter((t) => t.isParallel);
  const conflicts: string[] = [];

  for (let a = 0; a < parallelTasks.length; a++) {
    for (let b = a + 1; b < parallelTasks.length; b++) {
      const taskA = parallelTasks[a];
      const taskB = parallelTasks[b];

      for (const fileA of taskA.files) {
        for (const fileB of taskB.files) {
          if (fileA === fileB) {
            conflicts.push(
              `CONFLICT: ${taskA.id} and ${taskB.id} both modify \`${fileA}\``,
            );
          }
        }
      }
    }
  }

  return {
    safe: conflicts.length === 0,
    conflicts,
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────

/**
 * Extract dependency task IDs from a task block's **Dependencies:** field.
 */
function extractDependencies(block: string): string[] {
  const lines = block.split('\n');
  for (const line of lines) {
    if (/^\*\*Dependencies:\*\*/.test(line)) {
      const depsLine = line.replace(/^\*\*Dependencies:\*\*\s*/, '').trim();
      if (!depsLine || /^none$/i.test(depsLine)) {
        return [];
      }
      // Try T-XX format first
      const tRefs = depsLine.match(/T-[0-9]+/g);
      if (tRefs && tRefs.length > 0) {
        return tRefs;
      }
      // Fall back to plain numeric (e.g., "Task 1, Task 2" or "1, 2")
      const numRefs = depsLine.match(/[0-9]+/g);
      return numRefs ?? [];
    }
  }
  return [];
}

/**
 * Check if a task block is marked as parallelizable.
 */
function isParallelizable(block: string): boolean {
  const lines = block.split('\n');
  for (const line of lines) {
    if (/^\*\*Parallelizable:\*\*\s*[Yy]es/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract backtick-quoted file paths from a task block.
 */
function extractFiles(block: string): string[] {
  const filePattern = /`([a-zA-Z0-9_./-]+\.[a-zA-Z]+)`/g;
  const files: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(block)) !== null) {
    files.push(match[1]);
  }
  return files;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handleTaskDecomposition(
  args: TaskDecompositionArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.planPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'planPath is required' },
    };
  }

  // Read plan file
  let planContent: string;
  try {
    planContent = await readFile(args.planPath, 'utf-8');
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: 'SCRIPT_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Parse task blocks
  const blocks = parseTaskBlocks(planContent);

  if (blocks.length === 0) {
    return {
      success: false,
      error: {
        code: 'SCRIPT_ERROR',
        message: `No '### Task' headers found in plan file: ${args.planPath}`,
      },
    };
  }

  // Validate task structure
  let wellDecomposed = 0;
  let needsRework = 0;
  const structureRows: string[] = [];

  for (const block of blocks) {
    const result = validateTaskStructure(block.content);

    if (result.status === 'PASS') {
      wellDecomposed++;
    } else {
      needsRework++;
    }

    const descStatus = result.hasDescription
      ? `\u2713 (${result.descriptionWordCount} words)`
      : `\u2717 (${result.descriptionWordCount} words)`;
    const filesStatus = result.hasFiles
      ? `\u2713 (${result.fileCount} files)`
      : `\u2717 (0 files)`;
    const testsStatus = result.hasTests
      ? `\u2713 (${result.testCount} tests)`
      : `\u2717 (0 tests)`;

    structureRows.push(
      `| ${block.id} | ${descStatus} | ${filesStatus} | ${testsStatus} | ${result.status} |`,
    );
  }

  const totalTasks = blocks.length;

  // Validate dependency DAG
  const dagTasks: DagTask[] = blocks.map((b) => ({
    id: b.id,
    deps: extractDependencies(b.content),
  }));
  const dagResult = validateDependencyDAG(dagTasks);

  // Check parallel safety
  const parallelTasks: ParallelTask[] = blocks.map((b) => ({
    id: b.id,
    isParallel: isParallelizable(b.content),
    files: extractFiles(b.content),
  }));
  const safetyResult = checkParallelSafety(parallelTasks);

  // Build report
  const reportLines: string[] = [
    '## Task Decomposition Report',
    '',
    `**Plan:** \`${args.planPath}\``,
    '',
    '### Task Structure',
    '',
    '| Task | Description | Files | Tests | Status |',
    '|------|-------------|-------|-------|--------|',
    ...structureRows,
    '',
    '### Dependency Analysis',
  ];

  if (dagResult.valid) {
    reportLines.push('- Dependency graph: valid DAG \u2713');
  } else {
    reportLines.push(`- Dependency graph: CYCLE DETECTED: ${dagResult.cyclePath ?? 'unknown'}`);
  }
  reportLines.push('');

  reportLines.push('### Parallel Safety');
  if (safetyResult.safe) {
    reportLines.push('- No file conflicts detected \u2713');
  } else {
    for (const conflict of safetyResult.conflicts) {
      reportLines.push(`- ${conflict}`);
    }
  }
  reportLines.push('');

  reportLines.push('### Summary');
  reportLines.push(`- Well-decomposed: ${wellDecomposed}/${totalTasks} tasks`);
  reportLines.push(`- Needs rework: ${needsRework}/${totalTasks} tasks`);
  reportLines.push(`- Dependency: ${dagResult.valid ? 'valid DAG' : 'CYCLE DETECTED'}`);
  reportLines.push(
    `- Parallel safety: ${safetyResult.safe ? 'clean' : `${safetyResult.conflicts.length} conflict(s)`}`,
  );
  reportLines.push('');

  const passed = needsRework === 0 && dagResult.valid && safetyResult.safe;

  if (passed) {
    reportLines.push('**Result: PASS**');
  } else {
    reportLines.push(`**Result: FAIL** \u2014 ${needsRework} tasks need rework`);
  }

  const report = reportLines.join('\n');

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'task-decomposition', 'planning', passed, {
      dimension: 'D5',
      phase: 'plan',
      wellDecomposed,
      needsRework,
      totalTasks,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: TaskDecompositionResult = {
    passed,
    wellDecomposed,
    needsRework,
    totalTasks,
    dagValid: dagResult.valid,
    parallelSafe: safetyResult.safe,
    report,
  };

  return { success: true, data: result };
}
