/**
 * The plan coverage gate at the boundary between plan and plan-review. It checks that the plan
 * tasks cover each design section, and records the gate result.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { emitGateEvent, sameOperationGateKey } from './gate-utils.js';
import { acceptanceCriteriaFinding } from '../pure/design-completeness.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { designRegion } from '../pure/provenance-chain.js';

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

/** The words that {@link extractKeywords} ignores. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'this',
  'to', 'was', 'were', 'will', 'with',
]);

/**
 * Parses the `DR-N` requirement headings (`###` or `####`) from the design region of a unified
 * spec. The decomposition traces against these ids, so they are the coverage sections.
 *
 * The scan stops at the decomposition boundary, so an `**Implements:** DR-N` reference does not
 * count as a definition. A bullet `DR-N` entry does not define a requirement.
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
 * Maps each `DR-N` to the ids of the plan tasks that declare it in an `**Implements:**` line. It
 * reads the same signal as `check_provenance_chain`.
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
 * Parses the design sections from a markdown document. The `DR-N` requirement headings take
 * precedence when present. Otherwise it reads the `###` subsections under `## Technical Design`,
 * `## Design Requirements`, or `## Requirements` (case-insensitive). A `###` section with `####`
 * children gives the `####` headings instead.
 */
export function parseDesignSections(markdown: string): string[] {
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
    if (designHeaderPattern.test(line)) {
      inDesignSection = true;
      continue;
    }

    if (!inDesignSection) {
      continue;
    }

    if (/^##\s/.test(line) && !/^###/.test(line)) {
      inDesignSection = false;
      continue;
    }

    const h4Match = line.match(/^####\s+(.+)/);
    if (h4Match && h4Match[1] !== undefined && currentH3Index >= 0) {
      const subsectionName = h4Match[1].trim();
      const bucket = h4ByH3[currentH3Index];
      if (bucket !== undefined) bucket.push(subsectionName);
      continue;
    }

    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match && h3Match[1] !== undefined) {
      const sectionName = h3Match[1].trim();
      h3Headers.push(sectionName);
      h4ByH3.push([]);
      currentH3Index = h3Headers.length - 1;
      continue;
    }
  }

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

/**
 * Extracts the task headers (`### Task <id>: <title>`) from a plan. The id holds letters, digits,
 * and dashes, for example `001` or `A-01`.
 */
export function parsePlanTasks(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const lines = markdown.split('\n');

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
 * Extracts the task bodies from a plan. A body runs from a `### Task` header to the next task
 * header or `##` heading. The fallback coverage match reads only these bodies, so intro and
 * summary prose gives no false positives.
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

/**
 * Extract significant keywords from text. Converts to lowercase,
 * splits on non-alpha characters, filters stop words and short words (< 3 chars).
 */
export function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/\s+/);
  return words.filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

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
    const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(targetLower)) {
      matchCount++;
    }
  }

  if (sectionKeywords.length <= 1) {
    return matchCount >= 1;
  }
  return matchCount >= 2;
}

/**
 * Parses the deferred section names from the `## Traceability` or `## Spec Traceability` table of
 * a plan. A row with "Deferred" in any column is deferred. Its first column, without a number
 * prefix like "1.4 ", is the design section name. Separator and header rows are skipped.
 */
export function parseDeferredSections(planContent: string): string[] {
  const deferred: string[] = [];
  const lines = planContent.split('\n');
  let inTraceabilityTable = false;

  for (const line of lines) {
    if (/^##\s+(spec\s+traceability|traceability)\s*$/i.test(line)) {
      inTraceabilityTable = true;
      continue;
    }
    if (inTraceabilityTable && /^##\s/.test(line) && !/^###/.test(line)) {
      inTraceabilityTable = false;
    }

    if (!inTraceabilityTable) continue;

    if (!/deferred/i.test(line) || !line.includes('|')) {
      continue;
    }

    if (/^\|[\s-]+\|/.test(line.trim())) {
      continue;
    }

    if (/^\|\s*(Design Section|Section)/i.test(line.trim())) {
      continue;
    }

    const firstCol = line
      .replace(/^\s*\|\s*/, '')
      .replace(/\s*\|.*/, '')
      .replace(/^\d+(?:\.\d+)*\s+/, '')
      .trim();

    if (firstCol) {
      deferred.push(firstCol);
    }
  }

  return deferred;
}

/**
 * Detects the design sections with Given/When/Then acceptance criteria. It scans the `###` sections
 * under the design headers. A section counts when its body holds all three keywords, in bold, list,
 * or label form. It returns the `###` header text of each such section.
 */
export function detectGwtSections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const gwtSections: string[] = [];

  const designHeaderPattern = /^##\s+(technical\s+design|design\s+requirements|requirements)\s*$/i;
  let inDesignSection = false;
  let currentSectionName: string | null = null;
  let hasGwt = false;

  const gwtPattern = /(?:\*\*(Given|When|Then)\*\*|^[-*]\s+(Given|When|Then)\b|^\s+[-*]\s+(Given|When|Then)\b|(Given|When|Then)\s*:)/i;

  function extractGwtKeyword(line: string): string | null {
    const m = gwtPattern.exec(line);
    if (!m) return null;
    const kw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
    return kw;
  }

  let seenKeywords = new Set<string>();

  for (const line of lines) {
    if (designHeaderPattern.test(line)) {
      inDesignSection = true;
      continue;
    }

    if (!inDesignSection) {
      continue;
    }

    if (/^##\s/.test(line) && !/^###/.test(line)) {
      if (currentSectionName && seenKeywords.size === 3) {
        gwtSections.push(currentSectionName);
      }
      inDesignSection = false;
      currentSectionName = null;
      seenKeywords = new Set();
      continue;
    }

    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match && h3Match[1] !== undefined) {
      if (currentSectionName && seenKeywords.size === 3) {
        gwtSections.push(currentSectionName);
      }
      currentSectionName = h3Match[1].trim();
      seenKeywords = new Set();
      continue;
    }

    if (currentSectionName) {
      const kw = extractGwtKeyword(line);
      if (kw) {
        seenKeywords.add(kw);
      }
    }
  }

  if (currentSectionName && seenKeywords.size === 3) {
    gwtSections.push(currentSectionName);
  }

  return gwtSections;
}

/**
 * Parses the plan tasks with `**Test Layer:** acceptance`, with the comma-separated
 * `**Implements:**` references of each task.
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
      implementsDrs = implMatch[1]
        .split(/,\s*/)
        .map(dr => dr.trim())
        .filter(dr => dr.length > 0);
    }
  }

  flushTask();

  return result;
}

/**
 * Computes the coverage of the design sections by the plan tasks.
 *
 * A section that matches a deferred name counts as deferred, not as a gap. A `DR-N` section first
 * resolves through the `**Implements:**` references. Then come substring and keyword matches on
 * the task titles, and then on the task bodies without table rows. A section without a match is a
 * gap.
 *
 * With `designContent`, it also adds advisories for Given/When/Then requirements without an
 * acceptance test task. Advisories do not change the verdict.
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

    const matchedTasks: string[] = [];

    const drMatch = section.match(/\bDR-\d+\b/i);
    if (drMatch) {
      for (const id of implementsByDr.get(drMatch[0].toUpperCase()) ?? []) {
        matchedTasks.push(`Task ${id}`);
      }
    }

    if (matchedTasks.length === 0) {
      for (const task of tasks) {
        if (task.title.toLowerCase().includes(section.toLowerCase())) {
          matchedTasks.push(task.title);
          continue;
        }
        if (section.toLowerCase().includes(task.title.toLowerCase())) {
          matchedTasks.push(task.title);
          continue;
        }
        if (keywordMatch(sectionKeywords, task.title)) {
          matchedTasks.push(task.title);
        }
      }
    }

    if (matchedTasks.length === 0) {
      const taskBodies = extractTaskBodies(planContent);
      for (const body of taskBodies) {
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

  const advisories = designContent
    ? checkAcceptanceTestCoverage(designContent, planContent)
    : [];

  const report = buildReport(matrixRows, covered, gaps, deferredCount, total, gapSections);

  return {
    passed,
    coverage: { covered, gaps, deferred: deferredCount, total },
    report,
    gapSections,
    ...(advisories.length > 0 ? { advisories } : {}),
  };
}

/** True when a deferred name matches the section by substring in either direction, or by keywords. */
function isDeferredSection(
  section: string,
  sectionKeywords: string[],
  deferredSections: string[],
): boolean {
  for (const deferred of deferredSections) {
    if (deferred.toLowerCase().includes(section.toLowerCase())) {
      return true;
    }
    if (section.toLowerCase().includes(deferred.toLowerCase())) {
      return true;
    }

    const deferredKeywords = extractKeywords(deferred);
    if (keywordMatch(deferredKeywords, section) || keywordMatch(sectionKeywords, deferred)) {
      return true;
    }
  }
  return false;
}

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
    const drId = gwtSection.match(/^(DR-\d+)/i)?.[1];
    if (!drId) continue;

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

export async function handlePlanCoverage(
  args: { featureId: string; designPath: string; planPath: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
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

/**
 * Parses the design and the plan, computes the coverage, and records the gate event.
 *
 * It also adds the acceptance-criteria finding of the design-completeness check as an advisory,
 * through the shared `acceptanceCriteriaFinding`. That advisory does not change `passed`. The
 * other design-completeness checks are not here, because the spec template owns them.
 */
async function executePlanCoverage(
  args: { featureId: string; designPath: string; planPath: string },
  designContent: string,
  planContent: string,
  eventStore: EventStore,
): Promise<ToolResult> {
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

  const deferredSections = parseDeferredSections(planContent);

  const result = computeCoverage(designSections, tasks, planContent, deferredSections, designContent);

  const designAcceptanceFinding = acceptanceCriteriaFinding(designContent);
  const foldedAdvisories = [
    ...(result.advisories ?? []),
    ...(designAcceptanceFinding ? [designAcceptanceFinding] : []),
  ];
  const foldedResult =
    foldedAdvisories.length > 0 ? { ...result, advisories: foldedAdvisories } : result;

  await emitGateEvent(
    eventStore,
    args.featureId,
    'plan-coverage',
    'planning',
    result.passed,
    {
      dimension: 'D1',
      phase: 'plan',
      covered: result.coverage.covered,
      gaps: result.coverage.gaps,
      deferred: result.coverage.deferred,
      totalSections: result.coverage.total,
    },
    sameOperationGateKey('plan-coverage'),
  );

  return { success: true, data: { ...foldedResult } };
}
