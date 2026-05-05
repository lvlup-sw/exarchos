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

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Closed-set allowlist of file extensions accepted as real file paths by
 * `extractFiles` and `validateTaskStructure`. Tokens whose suffix is not
 * on this list (e.g. `imageProvenance.isFirstParty` — a TypeScript
 * record-field reference in narrative prose) are intentionally rejected
 * to avoid false parallel-safety conflicts on dotted-identifier tokens.
 *
 * Extensions are mirrored across both call sites; centralising here keeps
 * the two regexes in lockstep (T-14 REFACTOR).
 */
export const FILE_EXTENSION_ALLOWLIST: readonly string[] = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'yml',
  'yaml',
  'sh',
  'ps1',
  'sql',
  'kql',
  'bicep',
  'cs',
  'csproj',
  'sln',
  'go',
  'rs',
  'toml',
];

/**
 * Regex source fragment matching a backtick-quoted file path whose suffix
 * is on `FILE_EXTENSION_ALLOWLIST`. The capture group brackets the path so
 * the same source compiles for both `match` (line-level scanning) and
 * `exec` (capture-group extraction) call sites.
 */
const FILE_PATH_PATTERN_SOURCE = `\`([a-zA-Z0-9_./-]+\\.(?:${FILE_EXTENSION_ALLOWLIST.join('|')}))\``;

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
 * Extract the description span from a task block's lines.
 *
 * The description span is "everything between the task heading and the next
 * field-header (`**Word:**`) or section header (`### `)" — with the caveat
 * that the FIRST field-header encountered is treated as a description
 * introducer and is *included* in the span (its inline tail is captured;
 * the prose after it is also captured). The SECOND field-header terminates
 * the span.
 *
 * This handles the three canonical block shapes:
 * - Standard implementation-planning shape (`**Goal:**` + paragraph followed
 *   by `**Files:**`, `**Tests:**`, etc.) — Goal prose counts as description.
 * - Legacy explicit `**Description:**` shape — Description prose counts.
 * - Naked-prose shape (no field-headers at all) — full body counts.
 *
 * Returned as the array of captured raw lines (not yet word-counted) so
 * callers can decide how to render or score them.
 */
export function extractDescriptionSpan(lines: readonly string[]): string[] {
  const descLines: string[] = [];
  let firstFieldSeen = false;

  // Skip the leading task-heading line if present so its title text doesn't
  // pollute the description count.
  const start = lines.length > 0 && /^###\s+Task\s+/.test(lines[0]) ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^###\s/.test(line)) {
      break;
    }
    const fieldMatch = /^\*\*\w[\w\s]*:\*\*\s?(.*)$/.exec(line);
    if (fieldMatch) {
      if (firstFieldSeen) {
        // Second field-header — terminate the description span.
        break;
      }
      // First field-header — drop the `**Field:**` label, keep inline tail.
      firstFieldSeen = true;
      descLines.push(fieldMatch[1] ?? '');
      continue;
    }
    descLines.push(line);
  }

  return descLines;
}

/**
 * Validate a task block for description quality, file targets, and test
 * expectations.
 *
 * Description parsing (DR-5 step 1): see `extractDescriptionSpan` above.
 *
 * File detection: backtick-quoted paths like `path/to/file.ext`
 *
 * Test detection: `[RED]` markers or `Method_Scenario_Outcome` patterns
 * (PascalCase segments joined by underscores).
 */
export function validateTaskStructure(block: string): TaskStructureResult {
  const lines = block.split('\n');

  // --- Description (span from heading to next structural header) ---
  const descText = extractDescriptionSpan(lines).join(' ');
  const descWords = descText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const descriptionWordCount = descWords.length;
  const hasDescription = descriptionWordCount > 10;

  // --- File targets ---
  // Match backtick-quoted paths whose suffix is on `FILE_EXTENSION_ALLOWLIST`.
  // Without the allowlist, dotted-identifier tokens like
  // `imageProvenance.isFirstParty` (record-field references in prose) used
  // to match and pollute the file count / parallel-safety check.
  const filePattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
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
  // Cycle/unresolved comparisons run on the canonical ID (`canonicaliseTaskId`)
  // so that `T-002`, `T002`, and `002` are treated as the same task. We keep
  // a parallel map to recover the original ID for error messages.
  const visitState = new Map<string, number>();
  const canonicalToOriginal = new Map<string, string>();

  for (const task of tasks) {
    const canonical = canonicaliseTaskId(task.id);
    if (canonicalToOriginal.has(canonical)) {
      return { valid: false, cyclePath: `Duplicate task ID: ${task.id}` };
    }
    visitState.set(canonical, 0);
    canonicalToOriginal.set(canonical, task.id);
  }

  // Build adjacency map (canonical task -> canonical deps), reject
  // unresolved references against the canonical key set.
  const depsMap = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const canonicalSelf = canonicaliseTaskId(task.id);
    const canonicalDeps: string[] = [];
    for (const dep of task.deps) {
      const canonicalDep = canonicaliseTaskId(dep);
      if (!canonicalToOriginal.has(canonicalDep)) {
        return {
          valid: false,
          cyclePath: `Unresolved dependency: ${task.id} depends on unknown ${dep}`,
        };
      }
      canonicalDeps.push(canonicalDep);
    }
    depsMap.set(canonicalSelf, canonicalDeps);
  }

  // Iterative DFS over canonical IDs.
  for (const task of tasks) {
    const canonicalRoot = canonicaliseTaskId(task.id);
    if (visitState.get(canonicalRoot) !== 0) {
      continue;
    }

    // Stack entries: [canonicalNode, phase] where phase is 'enter' or 'exit'
    const stack: Array<[string, 'enter' | 'exit']> = [[canonicalRoot, 'enter']];

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
        return { valid: false, cyclePath: canonicalToOriginal.get(node) ?? node };
      }

      // Mark in-progress
      visitState.set(node, 1);
      stack.push([node, 'exit']);

      // Push dependencies
      const deps = depsMap.get(node) ?? [];
      for (const dep of deps) {
        const depState = visitState.get(dep);
        if (depState === 1) {
          // Cycle found \u2014 report using original IDs.
          const nodeOriginal = canonicalToOriginal.get(node) ?? node;
          const depOriginal = canonicalToOriginal.get(dep) ?? dep;
          return { valid: false, cyclePath: `${nodeOriginal} \u2192 ${depOriginal}` };
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
 *
 * Anchors strictly to the `**Dependencies:**` line — never falls back to
 * digit-scraping the wider block, which used to pull tokens like `24` out
 * of narrative prose ("`GetCslSloRollup24h`") and report them as unknown
 * dependencies.
 *
 * Matches both `T-NNN` and `TNNN` formats via a single word-boundary regex
 * (`\b(T-?\d+)\b`). The returned matches are verbatim — `T-001` stays
 * `T-001`, `T002` stays `T002`. The equivalence between `T-NNN`, `TNNN`,
 * and `NNN` (bare numeric IDs emitted by `parseTaskBlocks` for `### Task
 * 002:` headings) is handled at comparison time inside
 * `validateDependencyDAG`, not here, so this helper does not silently
 * mutate caller-visible IDs.
 *
 * Returns `[]` if no `T<id>`/`T-<id>` token is present (e.g. `none`,
 * empty, or "Task 1, Task 2"-style narrative without a recognised id).
 */
export function extractDependencies(block: string): string[] {
  const lines = block.split('\n');
  for (const line of lines) {
    if (/^\*\*Dependencies:\*\*/.test(line)) {
      const depsLine = line.replace(/^\*\*Dependencies:\*\*\s*/, '').trim();
      if (!depsLine || /^none$/i.test(depsLine)) {
        return [];
      }
      const tRefs = depsLine.match(/\bT-?\d+\b/g);
      return tRefs ?? [];
    }
  }
  return [];
}

/**
 * Canonicalise a task ID for cycle/unresolved-dependency comparison.
 *
 * Three forms are treated as equivalent: `T-002`, `T002`, and `002`. The
 * canonical form strips an optional leading `T-?` and then strips leading
 * zeros (so `T-01`, `T01`, `01`, and `1` all collapse to `1`).
 *
 * This bridges `parseTaskBlocks` (which preserves the form as written —
 * `T-XX` or bare numeric) and `extractDependencies` (which preserves
 * verbatim `T-NNN`/`TNNN` tokens from the deps line). Without this
 * normalisation, plans that mix forms — e.g. a fixture with bare-numeric
 * task IDs and `T<id>`-prefixed dependency references — would report
 * spurious unresolved-dependency errors.
 */
function canonicaliseTaskId(id: string): string {
  return id.replace(/^T-?/i, '').replace(/^0+/, '') || '0';
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
 *
 * The path's suffix MUST be on a closed extension allowlist; tokens whose
 * suffix is anything else (e.g. `imageProvenance.isFirstParty` —
 * a TypeScript record-field reference in narrative prose) are not treated
 * as file paths. Without this filter the parallel-safety check produces
 * false conflicts on dotted-identifier tokens shared between tasks.
 *
 * If the block contains an explicit `**Files:**` section, paths declared
 * under that section take precedence over inferred matches found elsewhere
 * in the block — explicit declarations are the source of truth.
 */
export function extractFiles(block: string): string[] {
  // Prefer files declared under an explicit `**Files:**` section when
  // present. Capture lines from the `**Files:**` header until the next
  // field-header (`**Word:**`) or section header (`### `).
  const lines = block.split('\n');
  const filesSectionLines: string[] = [];
  let inFilesSection = false;
  for (const line of lines) {
    if (/^\*\*Files:\*\*/i.test(line)) {
      inFilesSection = true;
      continue;
    }
    if (inFilesSection) {
      if (/^###\s/.test(line) || /^\*\*\w[\w\s]*:\*\*/.test(line)) {
        break;
      }
      filesSectionLines.push(line);
    }
  }

  if (filesSectionLines.length > 0) {
    const filesSection = filesSectionLines.join('\n');
    const declared: string[] = [];
    const sectionPattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
    let m: RegExpExecArray | null;
    while ((m = sectionPattern.exec(filesSection)) !== null) {
      declared.push(m[1]);
    }
    if (declared.length > 0) {
      return declared;
    }
  }

  // Fallback: scan the whole block for backtick-quoted paths with an
  // allowlisted extension.
  const blockPattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
  const files: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(block)) !== null) {
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
