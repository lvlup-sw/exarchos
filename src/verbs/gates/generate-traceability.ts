/**
 * Builds a traceability matrix from a design document and a plan document.
 * Each `##` and `###` header in the design region becomes a row. The row
 * matches `### Task N` headers in the plan and shows a coverage status.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import { designRegion } from '../pure/provenance-chain.js';

interface GenerateTraceabilityArgs {
  readonly designFile: string;
  readonly planFile: string;
  readonly outputFile?: string;
}

interface DesignSection {
  readonly name: string;
  readonly level: string;
}

interface PlanTask {
  readonly id: string;
  readonly title: string;
}

/** Extract ## and ### headers from a design document. */
function extractDesignSections(content: string): readonly DesignSection[] {
  const sections: DesignSection[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^(#{2,3})\s+(.+)/);
    if (match) {
      sections.push({
        level: match[1] ?? '',
        name: (match[2] ?? '').trimEnd(),
      });
    }
  }
  return sections;
}

/** Extract ### Task N headers from a plan document. */
function extractPlanTasks(content: string): readonly PlanTask[] {
  const tasks: PlanTask[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^###\s+Task\s+(\d+)/);
    if (match) {
      const id = match[1] ?? '';
      const colonIndex = line.indexOf(': ');
      const title = colonIndex !== -1 ? line.slice(colonIndex + 2) : line;
      tasks.push({ id, title });
    }
  }
  return tasks;
}

/**
 * Maps each `DR-N` requirement to the plan task ids that declare it in a
 * `**Implements:** DR-N[, DR-M]` line. `check_provenance_chain` uses the same
 * signal, so the matrix does not mark a `### DR-N` section "Uncovered" when a
 * task implements it.
 */
function extractImplementsByDr(planContent: string): Map<string, readonly string[]> {
  const byDr = new Map<string, string[]>();
  let currentTaskId: string | null = null;
  for (const line of planContent.split('\n')) {
    const taskMatch = line.match(/^###\s+Task\s+(\d+)/);
    if (taskMatch) {
      currentTaskId = taskMatch[1] ?? null;
      continue;
    }
    const implMatch = line.match(/\*\*Implements:\*\*\s*(.+)/i);
    if (implMatch && currentTaskId) {
      const drs = (implMatch[1] ?? '').match(/DR-\d+/gi) ?? [];
      for (const dr of drs) {
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
 * Builds the markdown matrix. For a `DR-N` section, the matches are the
 * `**Implements:**` task ids. If there is no match, the matches are the tasks
 * whose title contains the section name (case-insensitive). If there is still
 * no match, a mention in the plan body gives the id `?`.
 */
function generateTable(
  sections: readonly DesignSection[],
  tasks: readonly PlanTask[],
  planContent: string,
): { report: string; coveredCount: number; uncoveredCount: number } {
  const lines: string[] = [
    '## Spec Traceability',
    '',
    '### Traceability Matrix',
    '',
    '| Design Section | Key Requirements | Task ID(s) | Status |',
    '|----------------|-----------------|------------|--------|',
  ];

  let coveredCount = 0;
  let uncoveredCount = 0;

  const implementsByDr = extractImplementsByDr(planContent);

  for (const section of sections) {
    const matchedIds: string[] = [];

    const drMatch = section.name.match(/\bDR-\d+\b/i);
    if (drMatch) {
      matchedIds.push(...(implementsByDr.get(drMatch[0].toUpperCase()) ?? []));
    }

    if (matchedIds.length === 0) {
      for (const task of tasks) {
        if (task.title.toLowerCase().includes(section.name.toLowerCase())) {
          matchedIds.push(task.id);
        }
      }
    }

    if (matchedIds.length === 0) {
      if (planContent.toLowerCase().includes(section.name.toLowerCase())) {
        matchedIds.push('?');
      }
    }

    if (matchedIds.length > 0) {
      const ids = matchedIds.join(', ');
      lines.push(`| ${section.name} | (to be filled) | ${ids} | Covered |`);
      coveredCount++;
    } else {
      lines.push(`| ${section.name} | (to be filled) | \u2014 | Uncovered |`);
      uncoveredCount++;
    }
  }

  lines.push('');
  lines.push('### Scope Declaration');
  lines.push('');
  lines.push('**Target:** (to be filled)');
  lines.push('**Excluded:** (to be filled)');

  return {
    report: lines.join('\n'),
    coveredCount,
    uncoveredCount,
  };
}

/**
 * Reads the design and plan files and returns the matrix. Design sections come
 * from the design region only. So when design and plan are one artifact, the
 * `### Task` and `## Decomposition` headers stay out of the section column.
 * Plan tasks come from the full plan.
 */
export function handleGenerateTraceability(args: GenerateTraceabilityArgs): ToolResult {
  if (!existsSync(args.designFile)) {
    return {
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: `Design file not found: ${args.designFile}` },
    };
  }

  if (!existsSync(args.planFile)) {
    return {
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: `Plan file not found: ${args.planFile}` },
    };
  }

  const designContent = readFileSync(args.designFile, 'utf-8') as string;
  const planContent = readFileSync(args.planFile, 'utf-8') as string;

  const sections = extractDesignSections(designRegion(designContent));
  if (sections.length === 0) {
    return {
      success: false,
      error: { code: 'NO_SECTIONS', message: 'No ## or ### headers found in design document' },
    };
  }

  const tasks = extractPlanTasks(planContent);

  const { report, coveredCount, uncoveredCount } = generateTable(sections, tasks, planContent);

  if (args.outputFile) {
    writeFileSync(args.outputFile, report, 'utf-8');
  }

  const passed = uncoveredCount === 0;
  return {
    success: true,
    data: {
      passed,
      report,
      sections: sections.length,
      coveredCount,
      uncoveredCount,
    },
  };
}
