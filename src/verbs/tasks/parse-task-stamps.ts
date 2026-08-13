// ─── Plan-Format Stamp Parser (#1636) ────────────────────────────────────────
//
// Lifts the planner's per-task verification-routing stamps out of a decomposition
// markdown document so they can reach `prepare_delegation` / `classifyTask`.
//
// Motivation (#1636): the planner authors `**Risk Tier:**` / `**Boundary
// Touching:**` per task (task-template.md), and `deriveRiskTier` /
// `deriveBoundaryTouching` honor an explicit value ("planner value always wins").
// But nothing lifted those stamps out of the plan and onto the task objects, and
// the MCP `tasks` schema stripped them — so the override branch was structurally
// unreachable and every task fell through to the keyword/glob heuristic. This
// module is the deterministic lift: no LLM in the hot path.
//
// SoT note: this owns the stamp regexes for the DISPATCH path. The plan-coverage
// GATE (`task-decomposition.ts` `extractTaskRiskTier`, #1544) keeps its own
// riskTier regex — different concern, frozen parity tests. Both accept the same
// `**Risk Tier:** <tier>` / `**riskTier:** <tier>` spellings.
//
// Header note: the actual `docs/specs/` corpus authors task headers as `####`
// with numeric ids (`#### Task 001: …`), while `parseTaskBlocks` (the gate path)
// matches only `###` + `T-NN|NN`. This parser accepts BOTH `###` and `####` and
// a broader id token so it works on the real corpus.
// ─────────────────────────────────────────────────────────────────────────────

import type { RiskTier } from '../../workflow/verification-policy.js';
import {
  canonicaliseTaskId,
  extractFiles,
  extractDependencies,
} from './task-decomposition.js';

export type TestLayer = 'acceptance' | 'integration' | 'unit' | 'property';

/**
 * Normalise a task id for cross-form matching. `canonicaliseTaskId` collapses
 * `T-01`/`T01`/`01`/`1` → `1`, but it does NOT handle the spelled-out `task`
 * prefix the delegate skill emits (`id: "task-001"`): `^T-?` there strips only
 * the leading `t`, leaving `ask-001`. So a plan header `Task 001` (→ `1`) would
 * never match a caller's `task-001`. Strip a spelled-out `task<sep>` prefix
 * first (separator required, so a real word id like `taskrunner` is untouched),
 * then delegate to `canonicaliseTaskId` for the `T-?`/leading-zero collapse.
 */
export function normalizeTaskId(id: string): string {
  return canonicaliseTaskId(id.replace(/^task[-_\s]+/i, ''));
}

/** A task's planner-authored verification-routing stamps, lifted from the plan. */
export interface TaskStamp {
  /** Task id exactly as written in the plan header (e.g. "001", "T-03"). */
  readonly id: string;
  /** `normalizeTaskId(id)` — the form used to match against caller task ids. */
  readonly canonicalId: string;
  /** The header title text after the id. */
  readonly title: string;
  /** `**Risk Tier:**` stamp, if present. */
  readonly riskTier?: RiskTier;
  /** `**Boundary Touching:**` stamp, if present (may be explicitly `false`). */
  readonly boundaryTouching?: boolean;
  /** `**Test Layer:**` stamp, if present. */
  readonly testLayer?: TestLayer;
  /** Files declared under `**Files:**` (via the production `extractFiles`). */
  readonly files: string[];
  /** Dependency ids from `**Dependencies:**` (via `extractDependencies`). */
  readonly blockedBy: string[];
}

// A task header: `###`/`####`, then `Task`, then an id token, then a `:`/`—`/`-`
// separator, then the title. `Task\s+` (whitespace-required) means `### Tasks`
// (a section header) does not match.
const TASK_HEADER = /^#{3,4}\s+Task\s+([0-9A-Za-z.\-]+)\s*[:—-]\s*(.+?)\s*$/;
// A top-level section header (`#` / `##`) ends the preceding task block.
const SECTION_HEADER = /^#{1,2}\s+\S/;

// Stamp regexes. `(?![\w-])` (not `\b`): the value must end the token, so
// `riskTier: low-priority` does NOT read as `low` — a malformed stamp falls
// through to heuristic derivation instead of silently misclassifying (#1544).
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
 * Look up a task's stamp by id, matching on the canonical form so callers may
 * pass `task-001` / `T001` / `001` interchangeably against a plan that authored
 * `Task 001`. Returns `undefined` when the plan has no such task.
 */
export function stampForTask(
  stamps: readonly TaskStamp[],
  taskId: string,
): TaskStamp | undefined {
  const canonical = normalizeTaskId(taskId);
  return stamps.find((s) => s.canonicalId === canonical);
}
