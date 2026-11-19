/** Reads the verification stamps of typed and legacy plans. */

import { readValidatedDesignRecord } from '../../workflow/design-record/read.js';
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
  /** The normalized legacy id or the exact typed id. */
  readonly canonicalId: string;
  readonly matchExactId?: true;
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
function parseLegacyTaskStamps(planMarkdown: string): TaskStamp[] {
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

type StampReadResult =
  | Extract<ReturnType<typeof readValidatedDesignRecord>, { kind: 'invalid' }>
  | { readonly kind: 'typed' | 'legacy'; readonly stamps: TaskStamp[] };

/** Read stamps from a single capture of the plan bytes. */
export function readTaskStamps(bytes: Buffer, reference: string): StampReadResult {
  const record = readValidatedDesignRecord(bytes, reference);
  if (record.kind === 'invalid') return record;
  if (record.kind === 'legacy') {
    return { kind: 'legacy', stamps: parseLegacyTaskStamps(bytes.toString('utf8')) };
  }
  return {
    kind: 'typed',
    stamps: record.snapshot.tasks.map((task) => ({
      id: task.id,
      canonicalId: task.id,
      matchExactId: true,
      title: task.title,
      riskTier: task.riskTier,
      boundaryTouching: task.boundaryTouching,
      testLayer: task.testLayer,
      files: [...task.files],
      blockedBy: [...task.blockedBy],
    })),
  };
}

/** Read stamps from text and throw if the design record is invalid. */
export function parseTaskStamps(planMarkdown: string): TaskStamp[] {
  const result = readTaskStamps(Buffer.from(planMarkdown), 'plan');
  if (result.kind === 'invalid') throw new Error(result.message);
  return result.stamps;
}

/** Match typed ids exactly and normalize legacy ids before matching. */
export function stampForTask(
  stamps: readonly TaskStamp[],
  taskId: string,
): TaskStamp | undefined {
  const canonical = normalizeTaskId(taskId);
  return stamps.find((stamp) => stamp.matchExactId ? stamp.id === taskId : stamp.canonicalId === canonical);
}
