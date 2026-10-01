/**
 * Reads the per-task routing stamps of the planner (`**Risk Tier:**`, `**Boundary Touching:**`,
 * `**Test Layer:**`) from a decomposition markdown document. The stamps then reach
 * `prepare_delegation` and `classifyTask`, where an explicit planner value wins over the heuristic.
 * The parse is deterministic and uses no LLM.
 *
 * This module owns the stamp regexes for the dispatch path. The plan-coverage gate
 * (`extractTaskRiskTier` in `task-decomposition.ts`) keeps its own regex, and both accept the same spellings.
 * This parser accepts `###` and `####` task headers and a wider id token than `parseTaskBlocks`.
 */

import type { RiskTier } from '../../workflow/verification-policy.js';
import {
  canonicaliseTaskId,
  extractFiles,
  extractDependencies,
} from './task-decomposition.js';

export type TestLayer = 'acceptance' | 'integration' | 'unit' | 'property';

/**
 * Normalizes a task id for matching across forms. It removes a spelled-out `task` prefix with a
 * separator, and then calls `canonicaliseTaskId`, which collapses a `T` or `T-` prefix and leading zeros.
 * Without the first step, `canonicaliseTaskId` removes only the leading `t` of `task-<n>`.
 * The separator is required, so a word id such as `taskrunner` does not change.
 */
export function normalizeTaskId(id: string): string {
  return canonicaliseTaskId(id.replace(/^task[-_\s]+/i, ''));
}

/** A task's planner-authored verification-routing stamps, lifted from the plan. */
export interface TaskStamp {
  /** The task id exactly as the plan header writes it. */
  readonly id: string;
  /** `normalizeTaskId(id)` — the form used to match against caller task ids. */
  readonly canonicalId: string;
  /** The header title text after the id. */
  readonly title: string;
  /** `**Risk Tier:**` stamp, if present. */
  readonly riskTier?: RiskTier;
  /** The `**Boundary Touching:**` stamp, if present. It can be an explicit `false`. */
  readonly boundaryTouching?: boolean;
  /** `**Test Layer:**` stamp, if present. */
  readonly testLayer?: TestLayer;
  /** Files declared under `**Files:**` (via the production `extractFiles`). */
  readonly files: string[];
  /** Dependency ids from `**Dependencies:**` (via `extractDependencies`). */
  readonly blockedBy: string[];
}

/**
 * A task header: `###` or `####`, `Task`, an id token, a `:`, `—`, or `-` separator, and the title.
 * `Task\s+` requires whitespace, so the `### Tasks` section header does not match.
 */
const TASK_HEADER = /^#{3,4}\s+Task\s+([0-9A-Za-z.\-]+)\s*[:—-]\s*(.+?)\s*$/;
/** A top-level section header (`#` or `##`) ends the task block before it. */
const SECTION_HEADER = /^#{1,2}\s+\S/;

/**
 * The stamp regexes end with `(?![\w-])` and not `\b`, so `riskTier: low-priority` does not read as
 * `low`. A malformed stamp then falls through to the heuristic.
 */
const RISK_TIER_STAMP = /risk\s*tier\*{0,2}\s*:\s*\*{0,2}\s*(low|medium|high)(?![\w-])/i;
const BOUNDARY_STAMP = /boundary\s*touching\*{0,2}\s*:\s*\*{0,2}\s*(true|false)(?![\w-])/i;
const TEST_LAYER_STAMP =
  /test\s*layer\*{0,2}\s*:\s*\*{0,2}\s*(acceptance|integration|unit|property)(?![\w-])/i;

/**
 * Parse every task block out of a decomposition markdown document, returning the
 * per-task planner stamps. Pure: no I/O.
 *
 * A block runs from its `#### Task <id>:` header to the next task header or the
 * next top-level (`#`/`##`) section header, whichever comes first.
 */
export function parseTaskStamps(planMarkdown: string): TaskStamp[] {
  const lines = planMarkdown.split('\n');
  const headers: Array<{ idx: number; id: string; title: string }> = [];
  lines.forEach((line, idx) => {
    const m = TASK_HEADER.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      headers.push({ idx, id: m[1], title: m[2].trim() });
    }
  });

  const stamps: TaskStamp[] = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    if (header === undefined) continue;
    const start = header.idx;
    const nextHeader = headers[h + 1];
    let end = nextHeader !== undefined ? nextHeader.idx : lines.length;
    for (let i = start + 1; i < end; i++) {
      const li = lines[i];
      if (li !== undefined && SECTION_HEADER.test(li)) {
        end = i;
        break;
      }
    }
    const block = lines.slice(start, end).join('\n');
    const risk = RISK_TIER_STAMP.exec(block);
    const boundary = BOUNDARY_STAMP.exec(block);
    const testLayer = TEST_LAYER_STAMP.exec(block);
    stamps.push({
      id: header.id,
      canonicalId: normalizeTaskId(header.id),
      title: header.title,
      ...(risk && risk[1] !== undefined ? { riskTier: risk[1].toLowerCase() as RiskTier } : {}),
      ...(boundary && boundary[1] !== undefined ? { boundaryTouching: boundary[1].toLowerCase() === 'true' } : {}),
      ...(testLayer && testLayer[1] !== undefined ? { testLayer: testLayer[1].toLowerCase() as TestLayer } : {}),
      files: extractFiles(block),
      blockedBy: extractDependencies(block),
    });
  }
  return stamps;
}

/**
 * Finds the stamp of a task by its canonical id, so a caller can pass any id form that
 * {@link normalizeTaskId} collapses. It returns `undefined` when the plan has no such task.
 */
export function stampForTask(
  stamps: readonly TaskStamp[],
  taskId: string,
): TaskStamp | undefined {
  const canonical = normalizeTaskId(taskId);
  return stamps.find((s) => s.canonicalId === canonical);
}
