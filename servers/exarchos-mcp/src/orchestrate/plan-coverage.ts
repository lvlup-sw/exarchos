// ─── Plan Coverage Composite Action ─────────────────────────────────────────
//
// Pure TypeScript plan-to-design coverage verification. Replaces the
// bash script `scripts/verify-plan-coverage.sh` with native logic.
// Emits gate.executed events for the plan->plan-review boundary.
// ────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../events/store.js';
import { emitGateEvent } from './gate-utils.js';
import { acceptanceCriteriaFinding } from './pure/design-completeness.js';
import { createEvidenceSubject } from '../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { designRegion } from './pure/provenance-chain.js';

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
  readonly advisories?: readonly string[];
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

export interface AcceptanceTestTask {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly implementsDrs: readonly string[];
}

// ─── Stop Words ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'this',
  'to', 'was', 'were', 'will', 'with',
]);

// ─── Design Section Parsing ─────────────────────────────────────────────

/**
 * Parse `DR-N` requirement headings from the design region of a unified spec.
 *
 * WFQ-006: the current unified template declares design requirements as
 * `### DR-N …` / `#### DR-N …` headings under `## Design & Rationale`
 * (`### Requirements (DR-N)`). These identifiers are the single source the
 * decomposition traces against, so they — not the surrounding rationale
 * subsections (Problem Statement, Technical Design, …) — are the coverage
 * sections.
 *
 * Extraction is scoped to the design region (everything before the
 * decomposition boundary) so a task's `**Implements:** DR-N` *reference* is
 * never mistaken for a DR-N *definition*. Bullet-form DR-N entries are
 * intentionally NOT treated as requirement sections — only headings define a
 * traceable requirement.
 */
export function parseDesignRequirements(markdown: string): string[] {
  const sections: string[] = [];
  const seen = new Set<string>();
  const drHeadingPattern = /^#{3,4}\s+(DR-\d+\b.*)$/;

  for (const line of designRegion(markdown).split('\n')) {
    const match = drHeadingPattern.exec(line.trimEnd());
    const heading = match?.[1]?.trim();
    if (heading !== undefined && !seen.has(heading)) {
      seen.add(heading);
      sections.push(heading);
    }
  }

  return sections;
}

/**
 * Map each `DR-N` requirement to the plan task ids that declare it via a
 * `**Implements:** DR-N[, DR-M]` line. Mirrors the authoritative provenance
 * signal (`check_provenance_chain`) so DR-N design sections resolve coverage
 * from the decomposition's explicit references, not fuzzy keyword overlap.
 */
function extractImplementsByDr(planContent: string): Map<string, string[]> {
  const byDr = new Map<string, string[]>();
  const taskPattern = /^###\s+Task\s+([A-Za-z0-9-]+):/;
  const implementsPattern = /\*\*Implements:\*\*\s*(.+)/i;
  let currentTaskId: string | null = null;

  for (const line of planContent.split('\n')) {
    const taskMatch = line.match(taskPattern);
    if (taskMatch?.[1] !== undefined) {
      currentTaskId = taskMatch[1].trim();
      continue;
    }
    if (currentTaskId === null) continue;

    const implMatch = line.match(implementsPattern);
    if (implMatch?.[1] !== undefined) {
      for (const dr of implMatch[1].match(/DR-\d+/gi) ?? []) {
        const key = dr.toUpperCase();
        const ids = byDr.get(key) ?? [];
        if (!ids.includes(currentTaskId)) ids.push(currentTaskId);
        byDr.set(key, ids);
      }
    }
  }

  return byDr;
}

/**
 * Parse design sections from a markdown document.
 * Extracts ### subsections under `## Technical Design`, `## Design Requirements`,
 * or `## Requirements` headers (case-insensitive).
 *
 * When a ### section has #### children, the #### headers are used instead
 * (more granular). When a ### has no #### children, the ### itself is used.
 */
export function parseDesignSections(markdown: string): string[] {
  // WFQ-006: the canonical unified spec places design requirements as `DR-N`
  // subsections under `## Design & Rationale` (via `### Requirements (DR-N)`),
  // NOT under the legacy `## Technical Design` heading. Prefer the DR-N source
  // when present so current-template specs stop tripping NO_DESIGN_SECTIONS and
  // no longer need an artificial duplicate compatibility heading.
  const requirements = parseDesignRequirements(markdown);
  if (requirements.length > 0) {
    return requirements;
  }

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
    if (h4Match && h4Match[1] !== undefined && currentH3Index >= 0) {
      const subsectionName = h4Match[1].trim();
      const bucket = h4ByH3[currentH3Index];
      if (bucket !== undefined) bucket.push(subsectionName);
      continue;
    }

    // Collect ### headers
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match && h3Match[1] !== undefined) {
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
    const subs = h4ByH3[i];
    const header = h3Headers[i];
    if (subs !== undefined && subs.length > 0) {
      sections.push(...subs);
    } else if (header !== undefined) {
      sections.push(header);
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
    if (match && match[1] !== undefined && match[2] !== undefined) {
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
  let inTraceabilityTable = false;

  for (const line of lines) {
    // Detect traceability table section start
    if (/^##\s+(spec\s+traceability|traceability)\s*$/i.test(line)) {
      inTraceabilityTable = true;
      continue;
    }
    // Stop at next ## section (but not ### subsections)
    if (inTraceabilityTable && /^##\s/.test(line) && !/^###/.test(line)) {
      inTraceabilityTable = false;
    }

    // Only parse rows within the traceability table
    if (!inTraceabilityTable) continue;

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

// ─── Acceptance Test Detection ───────────────────────────────────────────

/**
 * Detect design sections that contain Given/When/Then acceptance criteria.
 * Scans ### sections under design headers and checks their body text
 * for the presence of **Given**, **When**, **Then** keywords.
 * Returns the section names (### header text) that have GWT criteria.
 */
export function detectGwtSections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const gwtSections: string[] = [];

  const designHeaderPattern = /^##\s+(technical\s+design|design\s+requirements|requirements)\s*$/i;
  let inDesignSection = false;
  let currentSectionName: string | null = null;
  let hasGwt = false;

  // Match bolded (**Given**), plain list (- Given), or label (Given:) forms
  const gwtPattern = /(?:\*\*(Given|When|Then)\*\*|^[-*]\s+(Given|When|Then)\b|^\s+[-*]\s+(Given|When|Then)\b|(Given|When|Then)\s*:)/i;

  function extractGwtKeyword(line: string): string | null {
    const m = gwtPattern.exec(line);
    if (!m) return null;
    const kw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
    return kw;
  }

  let seenKeywords = new Set<string>();

  for (const line of lines) {
    // Detect start of design section
    if (designHeaderPattern.test(line)) {
      inDesignSection = true;
      continue;
    }

    if (!inDesignSection) {
      continue;
    }

    // Detect next ## section (end of design section)
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      // Flush current section — require all three keywords
      if (currentSectionName && seenKeywords.size === 3) {
        gwtSections.push(currentSectionName);
      }
      inDesignSection = false;
      currentSectionName = null;
      seenKeywords = new Set();
      continue;
    }

    // New ### section
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match && h3Match[1] !== undefined) {
      // Flush previous section
      if (currentSectionName && seenKeywords.size === 3) {
        gwtSections.push(currentSectionName);
      }
      currentSectionName = h3Match[1].trim();
      seenKeywords = new Set();
      continue;
    }

    // Check for GWT keywords in body
    if (currentSectionName) {
      const kw = extractGwtKeyword(line);
      if (kw) {
        seenKeywords.add(kw);
      }
    }
  }

  // Flush last section
  if (currentSectionName && seenKeywords.size === 3) {
    gwtSections.push(currentSectionName);
  }

  return gwtSections;
}

/**
 * Parse plan tasks that have `**Test Layer:** acceptance`.
 * For each such task, also extracts the `**Implements:** DR-N` references.
 * Returns structured objects mapping task to the DRs it covers.
 */
export function parseAcceptanceTestTasks(planContent: string): AcceptanceTestTask[] {
  const result: AcceptanceTestTask[] = [];
  const lines = planContent.split('\n');

  const taskPattern = /^###\s+Task\s+([A-Za-z0-9-]+):\s+(.+)/;
  const testLayerPattern = /\*\*Test Layer:\*\*\s*acceptance/i;
  const implementsPattern = /\*\*Implements:\*\*\s*(.+)/i;

  let currentTaskId: string | null = null;
  let currentTaskTitle: string | null = null;
  let isAcceptance = false;
  let implementsDrs: string[] = [];

  function flushTask(): void {
    if (currentTaskId && currentTaskTitle && isAcceptance) {
      result.push({
        taskId: currentTaskId,
        taskTitle: currentTaskTitle,
        implementsDrs,
      });
    }
  }

  for (const line of lines) {
    const taskMatch = line.match(taskPattern);
    if (taskMatch && taskMatch[1] !== undefined && taskMatch[2] !== undefined) {
      // Flush previous task
      flushTask();
      currentTaskId = taskMatch[1].trim();
      currentTaskTitle = taskMatch[2].trim();
      isAcceptance = false;
      implementsDrs = [];
      continue;
    }

    if (!currentTaskId) continue;

    if (testLayerPattern.test(line)) {
      isAcceptance = true;
    }

    const implMatch = line.match(implementsPattern);
    if (implMatch && implMatch[1] !== undefined) {
      // Parse comma-separated DR references like "DR-1, DR-2"
      implementsDrs = implMatch[1]
        .split(/,\s*/)
        .map(dr => dr.trim())
        .filter(dr => dr.length > 0);
    }
  }

  // Flush last task
  flushTask();

  return result;
}

// ─── Coverage Computation ───────────────────────────────────────────────

/**
 * Compute coverage of design sections against plan tasks.
 * Returns pass/fail result with metrics and gap details.
 *
 * When `designContent` is provided, also checks that design requirements
 * with Given/When/Then acceptance criteria have corresponding acceptance
 * test tasks in the plan. Missing acceptance test tasks produce advisory
 * findings (non-blocking).
 */
export function computeCoverage(
  designSections: string[],
  tasks: PlanTask[],
  planContent: string,
  deferredSections: string[],
  designContent?: string,
): PlanCoverageResult {
  let covered = 0;
  let gaps = 0;
  let deferredCount = 0;
  const gapSections: string[] = [];
  const matrixRows: CoverageMatrixRow[] = [];
  const implementsByDr = extractImplementsByDr(planContent);

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

    // WFQ-006 (unified spec): a DR-N design section resolves coverage from the
    // decomposition's explicit `**Implements:** DR-N` references — the same
    // authoritative signal check_provenance_chain uses — before any fuzzy
    // keyword overlap. A DR-N with no implementing task stays an uncovered GAP.
    const drMatch = section.match(/\bDR-\d+\b/i);
    if (drMatch) {
      for (const id of implementsByDr.get(drMatch[0].toUpperCase()) ?? []) {
        matchedTasks.push(`Task ${id}`);
      }
    }

    if (matchedTasks.length === 0) {
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

  // Check acceptance test coverage for GWT sections (advisory only)
  const advisories = designContent
    ? checkAcceptanceTestCoverage(designContent, planContent)
    : [];

  // Build report
  const report = buildReport(matrixRows, covered, gaps, deferredCount, total, gapSections);

  return {
    passed,
    coverage: { covered, gaps, deferred: deferredCount, total },
    report,
    gapSections,
    ...(advisories.length > 0 ? { advisories } : {}),
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

// ─── Acceptance Test Coverage Check ──────────────────────────────────────

/**
 * Pure helper: checks whether design requirements with Given/When/Then
 * acceptance criteria have matching acceptance test tasks in the plan.
 * Returns advisory messages for DRs missing acceptance test tasks.
 * Does not affect pass/fail — advisories are informational only.
 */
export function checkAcceptanceTestCoverage(
  designContent: string,
  planContent: string,
): string[] {
  const gwtSections = detectGwtSections(designContent);
  if (gwtSections.length === 0) return [];

  const acceptanceTasks = parseAcceptanceTestTasks(planContent);
  const advisories: string[] = [];

  for (const gwtSection of gwtSections) {
    // Extract the DR identifier (e.g., "DR-1" from "DR-1: User Authentication")
    const drId = gwtSection.match(/^(DR-\d+)/i)?.[1];
    if (!drId) continue;

    // Check if any acceptance test task implements this DR
    const hasAcceptanceTest = acceptanceTasks.some(task =>
      task.implementsDrs.some(dr => dr.toUpperCase() === drId.toUpperCase()),
    );

    if (!hasAcceptanceTest) {
      advisories.push(
        `${drId} has Given/When/Then acceptance criteria but no plan task with **Test Layer:** acceptance implements it`,
      );
    }
  }

  return advisories;
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
  eventStore: EventStore,
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

  const artifactId =
    `plan-spec:${createHash('sha256').update(args.featureId).digest('hex').slice(0, 32)}`;
  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'plan-coverage',
    requirementId: 'requirement:plan-coverage',
    stateDir,
    eventStore,
    subject: () => createEvidenceSubject(
      { kind: 'artifact', artifactId },
      {
        designPath: args.designPath,
        planPath: args.planPath,
        designContent,
        planContent,
      },
    ),
    providerInput: args,
    executeProvider: async () =>
      executePlanCoverage(args, designContent, planContent, eventStore),
  });
}

async function executePlanCoverage(
  args: { featureId: string; designPath: string; planPath: string },
  designContent: string,
  planContent: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // The YAML gate-sidecar layer (#1298) was abandoned in #1494 — SQLite is
  // the authoritative structured record, so markdown parsing is the
  // permanent authoring-gate path.

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

  // Compute coverage (pass designContent for acceptance test advisory checks)
  const result = computeCoverage(designSections, tasks, planContent, deferredSections, designContent);

  // DR-6 gate fold (#1581 task 011): the design+plan collapse retires the
  // standalone `check_design_completeness` gate (tasks 013/014). Reproduce its
  // acceptance-criteria ("error-coverage") finding here, on the unified
  // `docs/specs/` artifact, so no coverage is lost when it leaves the chain.
  // The fold is ADVISORY — it rides in `advisories` and never flips
  // plan-coverage's `passed` (design-completeness was advisory-only too). One
  // shared finding-string source (`acceptanceCriteriaFinding`) keeps the two
  // gates from drifting. Only the acceptance-criteria check folds (DR-6 scope):
  // required-sections / multiple-options are authoring-template concerns owned
  // by the depth-scaled spec template (DR-5), not the runtime coverage gate.
  const designAcceptanceFinding = acceptanceCriteriaFinding(designContent);
  const foldedAdvisories = [
    ...(result.advisories ?? []),
    ...(designAcceptanceFinding ? [designAcceptanceFinding] : []),
  ];
  const foldedResult =
    foldedAdvisories.length > 0 ? { ...result, advisories: foldedAdvisories } : result;

  await emitGateEvent(eventStore, args.featureId, 'plan-coverage', 'planning', result.passed, {
    dimension: 'D1',
    phase: 'plan',
    covered: result.coverage.covered,
    gaps: result.coverage.gaps,
    deferred: result.coverage.deferred,
    totalSections: result.coverage.total,
  });

  return { success: true, data: { ...foldedResult } };
}
