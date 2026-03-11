// ─── Plan Coverage Composite Action ─────────────────────────────────────────
//
// Pure TypeScript plan-to-design coverage verification. Replaces the
// bash script `scripts/verify-plan-coverage.sh` with native logic.
// Emits gate.executed events for the plan->plan-review boundary.
// ────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Result Types ──────────────────────────────────────────────────────────

interface CoverageMetrics {
  readonly covered: number;
  readonly gaps: number;
  readonly deferred: number;
  readonly total: number;
}

interface PlanCoverageResult {
  readonly passed: boolean;
  readonly coverage: CoverageMetrics;
  readonly report: string;
  readonly gapSections: readonly string[];
}

interface CoverageMatrixRow {
  readonly section: string;
  readonly tasks: string;
  readonly status: 'Covered' | 'Deferred' | 'GAP';
}

export interface PlanTask {
  readonly id: string;
  readonly title: string;
}

// ─── Stop Words ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'this',
  'to', 'was', 'were', 'will', 'with',
]);

// ─── Design Section Parsing ─────────────────────────────────────────────

/**
 * Parse design sections from a markdown document.
 * Extracts ### subsections under `## Technical Design`, `## Design Requirements`,
 * or `## Requirements` headers (case-insensitive).
 *
 * When a ### section has #### children, the #### headers are used instead
 * (more granular). When a ### has no #### children, the ### itself is used.
 */
export function parseDesignSections(markdown: string): string[] {
  const lines = markdown.split('\n');

  const h3Headers: string[] = [];
  const h4ByH3: string[][] = [];
  let inDesignSection = false;
  let currentH3Index = -1;

  const designHeaderPattern = /^##\s+(technical\s+design|design\s+requirements|requirements)\s*$/i;

  for (const line of lines) {
    // Detect start of design section (case-insensitive)
    if (designHeaderPattern.test(line)) {
      inDesignSection = true;
      continue;
    }

    if (!inDesignSection) {
      continue;
    }

    // Detect next ## section (end of design section) -- must NOT be ### or ####
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      inDesignSection = false;
      continue;
    }

    // Collect #### headers under current ### (check BEFORE ### to avoid overwrite)
    const h4Match = line.match(/^####\s+(.+)/);
    if (h4Match && currentH3Index >= 0) {
      const subsectionName = h4Match[1].trim();
      h4ByH3[currentH3Index].push(subsectionName);
      continue;
    }

    // Collect ### headers
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      const sectionName = h3Match[1].trim();
      h3Headers.push(sectionName);
      h4ByH3.push([]);
      currentH3Index = h3Headers.length - 1;
      continue;
    }
  }

  // Build sections: prefer #### when available, fall back to ###
  const sections: string[] = [];
  for (let i = 0; i < h3Headers.length; i++) {
    if (h4ByH3[i].length > 0) {
      sections.push(...h4ByH3[i]);
    } else {
      sections.push(h3Headers[i]);
    }
  }

  return sections;
}

// ─── Plan Task Parsing ──────────────────────────────────────────────────

/**
 * Extract task headers from a plan markdown document.
 * Matches `### Task <id>: <title>` where id can be numeric (001)
 * or alphanumeric with dashes (T-01).
 */
export function parsePlanTasks(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const lines = markdown.split('\n');

  // Match: ### Task <id>: <title>
  // id can be: 001, 1, T-01, T-05, etc.
  const taskPattern = /^###\s+Task\s+([A-Za-z0-9-]+):\s+(.+)/;

  for (const line of lines) {
    const match = line.match(taskPattern);
    if (match) {
      tasks.push({
        id: match[1].trim(),
        title: match[2].trim(),
      });
    }
  }

  return tasks;
}

/**
 * Extract task body content from a plan markdown document.
 * Each body is the text between consecutive `### Task` headers.
 * Used for fallback coverage matching — restricts search to task
 * blocks only, avoiding false positives from intro/summary prose.
 */
function extractTaskBodies(markdown: string): string[] {
  const bodies: string[] = [];
  const lines = markdown.split('\n');
  const taskPattern = /^###\s+Task\s+[A-Za-z0-9-]+:\s+/;
  let currentBody: string[] = [];
  let inTask = false;

  for (const line of lines) {
    if (taskPattern.test(line)) {
      if (inTask && currentBody.length > 0) {
        bodies.push(currentBody.join('\n'));
      }
      currentBody = [];
      inTask = true;
      continue;
    }
    // Stop at next ## section (not ### or ####)
    if (inTask && /^##\s/.test(line) && !/^###/.test(line)) {
      bodies.push(currentBody.join('\n'));
      currentBody = [];
      inTask = false;
      continue;
    }
    if (inTask) {
      currentBody.push(line);
    }
  }
  if (inTask && currentBody.length > 0) {
    bodies.push(currentBody.join('\n'));
  }

  return bodies;
}

// ─── Keyword Extraction ─────────────────────────────────────────────────

/**
 * Extract significant keywords from text. Converts to lowercase,
 * splits on non-alpha characters, filters stop words and short words (< 3 chars).
 */
export function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/\s+/);
  return words.filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

// ─── Keyword Matching ───────────────────────────────────────────────────

/**
 * Check if target text contains enough matching keywords.
 * Requires at least 2 keyword matches, or 1 if there is only 1 keyword.
 * Matching is case-insensitive and word-boundary aware.
 */
export function keywordMatch(sectionKeywords: string[], targetText: string): boolean {
  if (sectionKeywords.length === 0) return false;

  const targetLower = targetText.toLowerCase();
  let matchCount = 0;

  for (const kw of sectionKeywords) {
    // Word-boundary matching using regex
    const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(targetLower)) {
      matchCount++;
    }
  }

  // Require at least 2 matches, or all keywords if only 1
  if (sectionKeywords.length <= 1) {
    return matchCount >= 1;
  }
  return matchCount >= 2;
}

// ─── Deferred Section Parsing ───────────────────────────────────────────

/**
 * Parse deferred section names from the plan's traceability table.
 * Rows containing "Deferred" (case-insensitive) in any column are treated
 * as explicitly deferred. The first column's text (with leading number
 * prefixes like "1.4 " stripped) is the design section name.
 */
export function parseDeferredSections(planContent: string): string[] {
  const deferred: string[] = [];
  const lines = planContent.split('\n');

  for (const line of lines) {
    // Must contain "Deferred" (case-insensitive) and pipe delimiters
    if (!/deferred/i.test(line) || !line.includes('|')) {
      continue;
    }

    // Skip separator rows (|-----|)
    if (/^\|[\s-]+\|/.test(line.trim())) {
      continue;
    }

    // Skip header rows
    if (/^\|\s*(Design Section|Section)/i.test(line.trim())) {
      continue;
    }

    // Extract first column: strip leading pipe, trim, strip number prefix
    const firstCol = line
      .replace(/^\s*\|\s*/, '')     // strip leading pipe + spaces
      .replace(/\s*\|.*/, '')        // strip everything after first pipe
      .replace(/^\d+(?:\.\d+)*\s+/, '') // strip number prefix like "1.4 "
      .trim();

    if (firstCol) {
      deferred.push(firstCol);
    }
  }

  return deferred;
}

// ─── Coverage Computation ───────────────────────────────────────────────

/**
 * Compute coverage of design sections against plan tasks.
 * Returns pass/fail result with metrics and gap details.
 */
export function computeCoverage(
  designSections: string[],
  tasks: PlanTask[],
  planContent: string,
  deferredSections: string[],
): PlanCoverageResult {
  let covered = 0;
  let gaps = 0;
  let deferredCount = 0;
  const gapSections: string[] = [];
  const matrixRows: CoverageMatrixRow[] = [];

  for (const section of designSections) {
    const sectionKeywords = extractKeywords(section);

    // Check if section is deferred first
    const isDeferred = isDeferredSection(section, sectionKeywords, deferredSections);
    if (isDeferred) {
      matrixRows.push({
        section,
        tasks: '(Deferred in traceability)',
        status: 'Deferred',
      });
      deferredCount++;
      continue;
    }

    // Try matching against task titles
    const matchedTasks: string[] = [];

    for (const task of tasks) {
      // Exact case-insensitive substring match
      if (task.title.toLowerCase().includes(section.toLowerCase())) {
        matchedTasks.push(task.title);
        continue;
      }
      if (section.toLowerCase().includes(task.title.toLowerCase())) {
        matchedTasks.push(task.title);
        continue;
      }
      // Keyword match
      if (keywordMatch(sectionKeywords, task.title)) {
        matchedTasks.push(task.title);
      }
    }

    // If no task title matches, check individual task bodies only
    // (not arbitrary plan prose, to avoid intro/summary false positives)
    if (matchedTasks.length === 0) {
      const taskBodies = extractTaskBodies(planContent);
      for (const body of taskBodies) {
        // Strip table rows within task body
        const cleanBody = body
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('|'))
          .join('\n');
        if (cleanBody.toLowerCase().includes(section.toLowerCase())) {
          matchedTasks.push('(referenced in task body)');
          break;
        } else if (keywordMatch(sectionKeywords, cleanBody)) {
          matchedTasks.push('(keyword match in task body)');
          break;
        }
      }
    }

    if (matchedTasks.length > 0) {
      matrixRows.push({
        section,
        tasks: matchedTasks.join(', '),
        status: 'Covered',
      });
      covered++;
    } else {
      matrixRows.push({
        section,
        tasks: '\u2014',
        status: 'GAP',
      });
      gapSections.push(section);
      gaps++;
    }
  }

  const total = covered + gaps + deferredCount;
  const passed = gaps === 0;

  // Build report
  const report = buildReport(matrixRows, covered, gaps, deferredCount, total, gapSections);

  return {
    passed,
    coverage: { covered, gaps, deferred: deferredCount, total },
    report,
    gapSections,
  };
}

// ─── Deferred Check Helper ──────────────────────────────────────────────

function isDeferredSection(
  section: string,
  sectionKeywords: string[],
  deferredSections: string[],
): boolean {
  for (const deferred of deferredSections) {
    // Exact case-insensitive substring match (both directions)
    if (deferred.toLowerCase().includes(section.toLowerCase())) {
      return true;
    }
    if (section.toLowerCase().includes(deferred.toLowerCase())) {
      return true;
    }

    // Keyword match
    const deferredKeywords = extractKeywords(deferred);
    if (keywordMatch(deferredKeywords, section) || keywordMatch(sectionKeywords, deferred)) {
      return true;
    }
  }
  return false;
}

// ─── Report Builder ─────────────────────────────────────────────────────

function buildReport(
  rows: CoverageMatrixRow[],
  covered: number,
  gaps: number,
  deferred: number,
  total: number,
  gapSections: string[],
): string {
  const lines: string[] = [];

  lines.push('## Plan Coverage Report');
  lines.push('');
  lines.push('### Coverage Matrix');
  lines.push('');
  lines.push('| Design Section | Task(s) | Status |');
  lines.push('|----------------|---------|--------|');

  for (const row of rows) {
    const statusDisplay = row.status === 'GAP' ? '**GAP**' : row.status;
    lines.push(`| ${row.section} | ${row.tasks} | ${statusDisplay} |`);
  }

  lines.push('');
  lines.push('### Summary');
  lines.push('');
  lines.push(`- Design sections: ${total}`);
  lines.push(`- Covered: ${covered}`);
  lines.push(`- Deferred: ${deferred}`);
  lines.push(`- Gaps: ${gaps}`);
  lines.push('');

  if (gapSections.length > 0) {
    lines.push('### Unmapped Sections');
    lines.push('');
    for (const gap of gapSections) {
      lines.push(`- **${gap}** \u2014 No task maps to this design section`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  if (gaps === 0) {
    if (deferred > 0) {
      lines.push(`**Result: PASS** (${covered}/${total} sections covered, ${deferred} deferred)`);
    } else {
      lines.push(`**Result: PASS** (${covered}/${total} sections covered)`);
    }
  } else {
    lines.push(`**Result: FAIL** (${gaps}/${total} sections have gaps)`);
  }

  return lines.join('\n');
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handlePlanCoverage(
  args: { featureId: string; designPath: string; planPath: string },
  stateDir: string,
): Promise<ToolResult> {
  // Input validation
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.designPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'designPath is required' },
    };
  }

  if (!args.planPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'planPath is required' },
    };
  }

  // Read files
  let designContent: string;
  let planContent: string;

  try {
    designContent = await readFile(args.designPath, 'utf-8') as string;
    planContent = await readFile(args.planPath, 'utf-8') as string;
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: 'FILE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Parse design sections
  const designSections = parseDesignSections(designContent);
  if (designSections.length === 0) {
    return {
      success: false,
      error: {
        code: 'NO_DESIGN_SECTIONS',
        message: "No design subsections found. Expected ### headers under '## Technical Design', '## Design Requirements', or '## Requirements'",
      },
    };
  }

  // Parse plan tasks
  const tasks = parsePlanTasks(planContent);
  if (tasks.length === 0) {
    return {
      success: false,
      error: {
        code: 'NO_PLAN_TASKS',
        message: `No '### Task' headers found in plan file: ${args.planPath}`,
      },
    };
  }

  // Parse deferred sections
  const deferredSections = parseDeferredSections(planContent);

  // Compute coverage
  const result = computeCoverage(designSections, tasks, planContent, deferredSections);

  // Emit gate.executed event (fire-and-forget)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'plan-coverage', 'planning', result.passed, {
      dimension: 'D1',
      phase: 'plan',
      covered: result.coverage.covered,
      gaps: result.coverage.gaps,
      deferred: result.coverage.deferred,
      totalSections: result.coverage.total,
    });
  } catch { /* fire-and-forget */ }

  return { success: true, data: result };
}
