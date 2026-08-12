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
import type { EventStore } from '../events/store.js';
import type { RiskTier } from '../workflow/verification-policy.js';
import { emitGateEvent } from './gate-utils.js';
import { canonicaliseTaskId } from '../utils/task-id.js';
import {
  assessDecompositionPlausibility,
  countBehaviors,
  extractBoundaryTouching,
  parseOverrides,
  type PlausibilityAssessment,
  type PlausibilityBaseline,
  type PlausibilityTaskInput,
} from './decomposition-plausibility.js';

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
  /**
   * #1544: the task's stamped verification-ladder tier, if the block declares
   * one. Drives whether tests are REQUIRED for a PASS (high/unstamped require
   * them; low/medium do not). `undefined` when the block carries no stamp.
   */
  readonly riskTier?: RiskTier;
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
  /**
   * P02-06: calibrated decomposition/risk plausibility findings. A STRUCTURED
   * CHALLENGE (typed findings the caller can act on), NOT a hard failure — it
   * does not flip `passed`. Implausible blanket risk/boundary stamps or
   * oversized tasks surface here rather than being silently accepted.
   */
  readonly plausibility: PlausibilityAssessment;
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
  // #1544: non-JS/TS source languages — a pytest task's `.py` path was not
  // recognized (✗ 0 files). Multi-char extensions unlikely to collide with the
  // dotted-identifier-in-prose tokens the allowlist exists to reject.
  'py',
  'rb',
  'java',
  'kt',
  'cpp',
  'tf',
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
 * A task-header id token: an optional `T`/`T-` prefix, then a **leading digit**,
 * then further id characters (digits, letters, dots, hyphens). Requiring the
 * token to start at a digit (behind the optional `T`) is what keeps non-task
 * `###`/`####` section headers like `### Task Structure` from being misread as a
 * task, while still accepting every id the real corpus uses — `001`, `1`,
 * `T-01`, `T01`, and the dotted `1.1` sub-numbering some legacy plans carry.
 *
 * This mirrors the broader id token in the SoT dispatch parser
 * (`parse-task-stamps.ts`), which documents this exact `###`-vs-`####` corpus
 * mismatch. The two parsers converge on the real **numeric-id** corpus (`001`,
 * `1`, `T-01`, `1.1`) so the plan-coverage GATE and the delegation DISPATCH path
 * read the same tasks; they intentionally differ on non-task-header rejection
 * (this parser requires a leading digit; `parse-task-stamps.ts` requires a
 * separator + title), so exotic letter-leading ids are handled differently — not
 * a case the corpus exercises.
 */
const TASK_ID_TOKEN_SOURCE = String.raw`(?:T-?)?[0-9][0-9A-Za-z.\-]*`;

/**
 * A task header at heading depth **3 (`###`, legacy plans) OR 4 (`####`, the
 * majority of the real `docs/specs/` corpus)**. `Task\s+` (whitespace required
 * after `Task`) means the section header `### Tasks` never matches. The id is
 * captured as group 1.
 *
 * Before #1670 this matched `/^###\s+Task\s+(T-[0-9]+|[0-9]+)/` — three hashes
 * only — so `extractTaskRiskTier` silently dropped tiers on the ~7 of 11 specs
 * authored entirely with `#### Task` headers (a corpus-wide gate failure).
 */
const TASK_HEADER_PATTERN = new RegExp(
  String.raw`^#{3,4}\s+Task\s+(${TASK_ID_TOKEN_SOURCE})`,
);

/** Matches a task heading line at either depth (id ignored). */
const TASK_HEADING_LINE = new RegExp(String.raw`^#{3,4}\s+Task\s+`);

/** Strips the `### Task <id>:` / `#### Task <id>:` prefix off a heading line. */
const TASK_HEADING_PREFIX = new RegExp(
  String.raw`^#{3,4}\s+Task\s+(?:${TASK_ID_TOKEN_SOURCE}):?\s*`,
);

/** Any markdown heading at task depth — terminates a description span. */
const TASK_DEPTH_HEADING = /^#{3,4}\s/;

/**
 * Extract task blocks from plan markdown content.
 *
 * Each task starts with `### Task <id>:` or `#### Task <id>:` (id may be
 * `T-XX`, `TXX`, a bare number, or dotted `N.M`) and ends at the next task
 * header (of either depth) or EOF.
 */
export function parseTaskBlocks(content: string): TaskBlock[] {
  const lines = content.split('\n');
  const blocks: TaskBlock[] = [];

  let currentId: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = TASK_HEADER_PATTERN.exec(line);
    if (match) {
      // Save previous block
      if (currentId !== null) {
        blocks.push({ id: currentId, content: currentLines.join('\n') });
      }
      currentId = match[1] ?? null;
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
 * The description span is the union of:
 *
 *  1. The **brief-description tail of the `### Task N: …` heading** — the
 *     text after the `### Task N:` prefix. (T-02 / #1486.)
 *  2. The **body span** — "everything between the task heading and the next
 *     field-header (`**Word:**`) or section header (`### `)", with the caveat
 *     that the FIRST field-header encountered is treated as a description
 *     introducer and is *included* in the span (its inline tail is captured;
 *     the prose after it is also captured). The SECOND field-header
 *     terminates the span.
 *
 * Together these handle four canonical block shapes:
 * - **task-template.md shape** (T-02 / #1486): the brief description lives IN
 *   the `### Task [N]: [Brief Description]` heading and the body opens
 *   immediately with `**Phase:**` (a NON-introducer field header). The body
 *   span is therefore empty, but the heading tail carries the description.
 *   Before T-02 the heading line was skipped wholesale and `**Phase:**`
 *   terminated the scan, so these template-verbatim tasks scored
 *   `Description: 0 words` and hard-FAILED the gate (`needsRework`). See
 *   `skills-src/plan/references/task-template.md`.
 * - Standard plan shape (`**Goal:**` + paragraph followed
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

  // T-02 (#1486): capture the heading's brief-description tail (text after
  // `### Task N:`) as a description signal. The task-template.md shape puts
  // the description in the heading, so without this the body-only span is
  // empty for template-verbatim tasks. We do NOT count backtick-quoted file
  // paths here (template headings are prose, not file lists), so this does
  // not reopen the F20/#1213 hole guarded against below.
  //
  // #1670: recognise both `###` and `####` task headings so the heading-tail
  // description is credited on the majority-4-hash corpus, not just legacy
  // 3-hash plans.
  const firstLine = lines[0];
  const start = firstLine !== undefined && TASK_HEADING_LINE.test(firstLine) ? 1 : 0;
  if (start === 1 && firstLine !== undefined) {
    const headingTail = firstLine.replace(TASK_HEADING_PREFIX, '');
    // Strip backtick-quoted spans (file paths like `src/a.ts`) before counting
    // the tail as description — a heading that is nothing but a file list must
    // NOT satisfy the description threshold (the F20/#1213 hole this comment
    // claims to avoid). Only the prose remnant counts.
    const headingTailProse = headingTail.replace(/`[^`]*`/g, ' ').trim();
    if (headingTailProse.length > 0) {
      descLines.push(headingTailProse);
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // #1670: terminate the span at the next task-depth (`###`/`####`) heading —
    // previously only `###` broke the scan, so a 4-hash sub-heading leaked into
    // the description on the majority-4-hash corpus.
    if (TASK_DEPTH_HEADING.test(line)) {
      break;
    }
    // F20 (#1213): capture the LABEL inside `**...:**` separately so we
    // can distinguish description introducers (`**Goal:**`,
    // `**Description:**`) from non-description structural headers
    // (`**Files:**`, `**Tests:**`, `**Dependencies:**`,
    // `**Parallelizable:**`, `**Acceptance criteria:**`, …).
    //
    // Previously the FIRST `**Field:**` line was treated as the
    // description introducer regardless of label. Tasks that opened with
    // `**Files:** \`a.ts\`, \`b.ts\`, \`c.ts\``, etc. inadvertently had
    // their inline file list counted as description prose, satisfying
    // the 10-word threshold and masking missing-description failures.
    //
    // Now: only `Goal` / `Description` (case-insensitive) introduce the
    // span. Any other label terminates the scan immediately, leaving
    // any preceding naked-prose lines as the description (handles the
    // legacy "no field-headers at all" shape via the `else` branch
    // below).
    const fieldMatch = /^\*\*(\w[\w\s]*?):\*\*\s?(.*)$/.exec(line);
    if (fieldMatch) {
      const label = (fieldMatch[1] ?? '').trim();
      const isDescriptionIntroducer = /^(goal|description)$/i.test(label);
      if (firstFieldSeen) {
        // Second field-header — terminate the description span.
        break;
      }
      if (!isDescriptionIntroducer) {
        // Non-description header reached before any introducer —
        // terminate the scan WITHOUT swallowing this line. Any naked
        // prose preceding it (already pushed to `descLines`) remains
        // the description.
        break;
      }
      // First description-introducer — drop the label, keep inline tail.
      firstFieldSeen = true;
      descLines.push(fieldMatch[2] ?? '');
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

  // #1544: the test requirement SCALES BY the task's verification-ladder tier.
  // The universal `hasFiles && hasTests` hard-FAIL flagged every low/medium-tier
  // task lacking tests — the over-flag that trained operators to ignore the gate
  // (the same gate that false-FAILed this very feature's low-tier authoring
  // tasks at plan-review). Under the ladder, low/medium tasks need not carry
  // tests to PASS; high-tier — and, conservatively, UNSTAMPED — tasks still do.
  // (The word-count threshold was already removed; it remains an informational
  // column only.)
  const riskTier = extractTaskRiskTier(block);
  const testsRequired = riskTier !== 'low' && riskTier !== 'medium';
  const status = hasFiles && (!testsRequired || hasTests) ? 'PASS' : 'FAIL';

  return {
    hasDescription,
    descriptionWordCount,
    hasFiles,
    fileCount,
    hasTests,
    testCount,
    ...(riskTier ? { riskTier } : {}),
    status,
  };
}

/**
 * #1544: extract a task block's stamped verification-ladder `riskTier`, if any.
 *
 * Matches a real risk-tier stamp — the key, then a colon, then the tier word —
 * tolerating both spellings planners actually use: the camelCase `**riskTier:**
 * high` (used by existing plans) and the title-case `**Risk Tier:** high` that
 * the task template (`@skills/plan/references/task-template.md`)
 * literally prescribes — plus the markdown bold around either. The optional space
 * in `risk\s*tier` is load-bearing: without it a plan authored to the canonical
 * template reads as unstamped and a low-tier task wrongly fails (#1544).
 * Binding the tier to the key (rather than reading any tier word on a line that
 * merely mentions the term) avoids two misclassifications: prose like "the
 * riskTier governs high-blast tasks" no longer reads as `high`, and a line with
 * several tier words yields the one bound to the key. Returns `undefined` when
 * the block carries no stamp — the conservative path that still requires tests.
 */
function extractTaskRiskTier(block: string): RiskTier | undefined {
  // `(?![\w-])` (not plain `\b`): the tier word must end the token. `\b` would
  // match before a hyphen, so `riskTier: low-priority` would wrongly read as
  // `low`; rejecting a trailing hyphen/word-char makes a malformed stamp fall
  // through to the conservative default instead of silently misclassifying.
  const stamp = /risk\s*tier\*{0,2}\s*:\s*\*{0,2}\s*(low|medium|high)(?![\w-])/i;
  for (const line of block.split('\n')) {
    const match = stamp.exec(line);
    if (match && match[1] !== undefined) return match[1].toLowerCase() as RiskTier;
  }
  return undefined;
}

// ─── Dependency DAG Validation ──────────────────────────────────────────

/**
 * fix-008 (review #1213): build the canonical-ID lookup tables in one place.
 *
 * Returns the `visitState` (canonical \u2192 0/1/2 cycle marker), the
 * `canonicalToOriginal` map (used to surface error messages with the
 * caller's original ID spelling), and the `depsMap` (canonical \u2192
 * canonical[] adjacency). May short-circuit with an `error` describing a
 * duplicate ID or unresolved dependency \u2014 both halt validation up front
 * before any DFS work runs.
 */
type CanonicalMaps = {
  readonly kind: 'ok';
  readonly visitState: Map<string, number>;
  readonly canonicalToOriginal: Map<string, string>;
  readonly depsMap: Map<string, readonly string[]>;
};

type CanonicalMapsError = {
  readonly kind: 'error';
  readonly result: DagValidationResult;
};

function buildCanonicalMaps(
  tasks: readonly DagTask[],
): CanonicalMaps | CanonicalMapsError {
  const visitState = new Map<string, number>();
  const canonicalToOriginal = new Map<string, string>();

  for (const task of tasks) {
    const canonical = canonicaliseTaskId(task.id);
    if (canonicalToOriginal.has(canonical)) {
      return {
        kind: 'error',
        result: { valid: false, cyclePath: `Duplicate task ID: ${task.id}` },
      };
    }
    visitState.set(canonical, 0);
    canonicalToOriginal.set(canonical, task.id);
  }

  const depsMap = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const canonicalSelf = canonicaliseTaskId(task.id);
    const canonicalDeps: string[] = [];
    for (const dep of task.deps) {
      const canonicalDep = canonicaliseTaskId(dep);
      if (!canonicalToOriginal.has(canonicalDep)) {
        return {
          kind: 'error',
          result: {
            valid: false,
            cyclePath: `Unresolved dependency: ${task.id} depends on unknown ${dep}`,
          },
        };
      }
      canonicalDeps.push(canonicalDep);
    }
    depsMap.set(canonicalSelf, canonicalDeps);
  }

  return { kind: 'ok', visitState, canonicalToOriginal, depsMap };
}

/**
 * fix-008 (review #1213): iterative DFS over the canonical adjacency.
 *
 * `visit` is mutated in place (caller-owned). On detecting a cycle the
 * function returns a `DagValidationResult` carrying the offending edge
 * (in original-ID spelling); on a clean traversal it returns `null` so
 * the outer loop can advance to the next root.
 *
 * Stack entries are `[canonicalNode, phase]` where phase is `'enter'` for
 * descent and `'exit'` for the post-order mark; this lets the iterative
 * DFS mirror the recursive shape (pre-order discover, post-order finish)
 * without recursion overhead or stack-depth limits on large plans.
 */
function dfsCycleCheck(
  root: string,
  adj: ReadonlyMap<string, readonly string[]>,
  visit: Map<string, number>,
  canonicalToOriginal: ReadonlyMap<string, string>,
): DagValidationResult | null {
  const stack: Array<[string, 'enter' | 'exit']> = [[root, 'enter']];

  while (stack.length > 0) {
    const [node, phase] = stack.pop()!;

    if (phase === 'exit') {
      visit.set(node, 2);
      continue;
    }

    const state = visit.get(node);

    // Already fully explored
    if (state === 2) {
      continue;
    }

    // Cycle: node is in-progress (already on the DFS stack)
    if (state === 1) {
      return { valid: false, cyclePath: canonicalToOriginal.get(node) ?? node };
    }

    visit.set(node, 1);
    stack.push([node, 'exit']);

    const deps = adj.get(node) ?? [];
    for (const dep of deps) {
      const depState = visit.get(dep);
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

  return null;
}

/**
 * Validate that the dependency graph among tasks is a DAG (no cycles).
 *
 * Uses iterative DFS with explicit stack tracking. Each node has three states:
 * - 0 = unvisited
 * - 1 = in-progress (on the DFS stack)
 * - 2 = done (fully explored)
 *
 * A cycle is detected when we encounter a node that is in-progress. Map-
 * construction and the DFS itself are extracted to `buildCanonicalMaps`
 * and `dfsCycleCheck` so this function reads as orchestration only.
 */
export function validateDependencyDAG(tasks: readonly DagTask[]): DagValidationResult {
  // Cycle/unresolved comparisons run on the canonical ID
  // (`canonicaliseTaskId`) so that `T-002`, `T002`, and `002` are treated
  // as the same task. We keep a parallel map to recover the original ID
  // for error messages.
  const maps = buildCanonicalMaps(tasks);
  if (maps.kind === 'error') return maps.result;

  for (const task of tasks) {
    const canonicalRoot = canonicaliseTaskId(task.id);
    if (maps.visitState.get(canonicalRoot) !== 0) {
      continue;
    }
    const cycle = dfsCycleCheck(
      canonicalRoot,
      maps.depsMap,
      maps.visitState,
      maps.canonicalToOriginal,
    );
    if (cycle !== null) return cycle;
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
      if (taskA === undefined || taskB === undefined) continue;

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
 *
 * Exported so cross-module comparators (e.g. `computeScopedWorktrees`,
 * which compares caller-supplied task IDs against projection-held
 * `readyTaskIds`) collapse mixed forms identically.
 *
 * The implementation lives in the dependency-free leaf `utils/task-id.ts` so
 * the views layer can share it without importing the orchestrate layer.
 */
export { canonicaliseTaskId };

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
  // field-header (`**Word:**`) or section header (`###`/`####`).
  const lines = block.split('\n');
  const filesSectionLines: string[] = [];
  let inFilesSection = false;
  // F21 (#1213): track whether the block contained an explicit **Files:**
  // header at all. If so, the section is AUTHORITATIVE — even when it
  // declares zero allowlisted paths (e.g. `**Files:** none`, an empty
  // section, or paths with non-allowlisted extensions only). Without
  // this flag, an empty Files section silently fell through to
  // whole-block inference and scraped unrelated backticks elsewhere in
  // the body, producing false-positive parallel-conflict reports.
  let sawFilesSection = false;
  for (const line of lines) {
    if (/^\*\*Files:\*\*/i.test(line)) {
      inFilesSection = true;
      sawFilesSection = true;
      // CodeRabbit #17 (#1213): if the **Files:** header line itself
      // contains paths after the colon (inline form, e.g.
      // `**Files:** \`a.ts\`, \`b.ts\``), capture them. Without this,
      // single-line Files headers were silently dropped.
      const inlineTail = line.replace(/^\*\*Files:\*\*\s*/i, '');
      if (inlineTail.length > 0) {
        filesSectionLines.push(inlineTail);
      }
      continue;
    }
    if (inFilesSection) {
      // Terminate at the next section header at EITHER depth (`###`/`####`, via
      // TASK_DEPTH_HEADING) or field-header — a 4-hash sub-section on the
      // majority-`####` corpus must end the Files scan, not be swept into it
      // (same 3-hash-only bug DR-5 fixed for parseTaskBlocks; extractFiles was
      // the sibling it missed).
      if (TASK_DEPTH_HEADING.test(line) || /^\*\*\w[\w\s]*:\*\*/.test(line)) {
        inFilesSection = false;
        continue;
      }
      filesSectionLines.push(line);
    }
  }

  if (sawFilesSection) {
    // Authoritative path: an explicit **Files:** section was present.
    // Return whatever IT declares (possibly empty); do NOT fall through
    // to whole-block inference. This prevents `**Files:** none` (or an
    // empty section) from being silently overridden by unrelated
    // backticks elsewhere in the task body.
    const filesSection = filesSectionLines.join('\n');
    const declared: string[] = [];
    const sectionPattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
    let m: RegExpExecArray | null;
    while ((m = sectionPattern.exec(filesSection)) !== null) {
      if (m[1] !== undefined) declared.push(m[1]);
    }
    return declared;
  }

  // Fallback: no explicit **Files:** section appeared at all. Scan the
  // whole block for backtick-quoted paths with an allowlisted extension.
  const blockPattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
  const files: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(block)) !== null) {
    if (match[1] !== undefined) files.push(match[1]);
  }
  return files;
}

// ─── Plausibility Bridge (P02-06) ─────────────────────────────────────────

/**
 * Bridge parsed task blocks into the structured `PlausibilityTaskInput`s the
 * plausibility assessor consumes. Reuses the structural gate's own extractors
 * (`extractFiles`, `extractTaskRiskTier`) so the plausibility signals read the
 * SAME files/tier the structure check reads — no parallel parser to drift.
 */
export function extractPlausibilityInputs(
  blocks: readonly TaskBlock[],
): PlausibilityTaskInput[] {
  return blocks.map((block) => {
    const riskTier = extractTaskRiskTier(block.content);
    const boundaryTouching = extractBoundaryTouching(block.content);
    return {
      id: block.id,
      files: extractFiles(block.content),
      behaviorCount: countBehaviors(block.content),
      ...(riskTier ? { riskTier } : {}),
      ...(boundaryTouching !== undefined ? { boundaryTouching } : {}),
      overrides: parseOverrides(block.content),
    };
  });
}

/**
 * Render the plausibility assessment as a markdown report section. Active
 * challenges are surfaced as `CHALLENGE` lines (the structured, non-silent
 * signal); overridden ones are listed with their recorded rationale so the
 * override is auditable rather than invisible.
 */
function renderPlausibilitySection(assessment: PlausibilityAssessment): string[] {
  const lines: string[] = ['### Decomposition Plausibility'];
  if (!assessment.challenged && assessment.overridden.length === 0) {
    lines.push('- No plausibility challenges \u2713');
    return lines;
  }
  for (const challenge of assessment.challenges) {
    lines.push(`- CHALLENGE (${challenge.signal}): ${challenge.message}`);
  }
  for (const overridden of assessment.overridden) {
    lines.push(
      `- OVERRIDDEN (${overridden.signal}): ${overridden.message} ` +
        `\u2014 rationale: ${overridden.overrideRationale}`,
    );
  }
  return lines;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handleTaskDecomposition(
  args: TaskDecompositionArgs,
  _stateDir: string,
  eventStore: EventStore,
  baseline?: PlausibilityBaseline,
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

  // The YAML gate-sidecar layer (#1298) was abandoned in #1494 — SQLite is
  // the authoritative structured record, so markdown parsing is the
  // permanent authoring-gate path.

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
        message: `No '### Task' / '#### Task' headers found in plan file: ${args.planPath}`,
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
    // #1544: a low/medium-tier task without tests is not a FAIL \u2014 show it as
    // not-required-for-tier rather than a bare \u2717 that contradicts the PASS.
    const testsStatus = result.hasTests
      ? `\u2713 (${result.testCount} tests)`
      : result.riskTier === 'low' || result.riskTier === 'medium'
        ? `\u2014 (n/a: ${result.riskTier} tier)`
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

  // P02-06: calibrated decomposition/risk plausibility. Structured challenge,
  // NOT a hard failure — surfaced in the report and the returned `plausibility`
  // field so implausible blanket stamps / oversized tasks are not silently
  // accepted, while remaining overridable with a recorded rationale.
  const plausibility = assessDecompositionPlausibility(
    extractPlausibilityInputs(blocks),
    {
      ...(baseline ? { baseline } : {}),
      planOverrides: parseOverrides(planContent),
    },
  );
  reportLines.push(...renderPlausibilitySection(plausibility));
  reportLines.push('');

  reportLines.push('### Summary');
  reportLines.push(`- Well-decomposed: ${wellDecomposed}/${totalTasks} tasks`);
  reportLines.push(`- Needs rework: ${needsRework}/${totalTasks} tasks`);
  reportLines.push(`- Dependency: ${dagResult.valid ? 'valid DAG' : 'CYCLE DETECTED'}`);
  reportLines.push(
    `- Parallel safety: ${safetyResult.safe ? 'clean' : `${safetyResult.conflicts.length} conflict(s)`}`,
  );
  reportLines.push(
    `- Plausibility: ${plausibility.challenged ? `${plausibility.challenges.length} challenge(s)` : 'clean'}`,
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
    plausibility,
    report,
  };

  return { success: true, data: { ...result } };
}
