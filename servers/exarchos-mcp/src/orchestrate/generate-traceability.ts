// ─── Generate Traceability Matrix ────────────────────────────────────────────
//
// Generates a traceability matrix from design and plan markdown documents.
// Extracts ## and ### headers from the design file, matches them to
// ### Task N headers in the plan file, and produces a markdown table
// showing coverage status.
//
// Port of scripts/generate-traceability.sh to pure TypeScript.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ToolResult } from '../format.js';
import { designRegion } from './pure/provenance-chain.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Extraction Helpers ─────────────────────────────────────────────────────

/** Extract ## and ### headers from a design document. */
function extractDesignSections(content: string): readonly DesignSection[] {
  const sections: DesignSection[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^(#{2,3})\s+(.+)/);
    if (match) {
      sections.push({
        level: match[1],
        name: match[2].trimEnd(),
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
      const id = match[1];
      const colonIndex = line.indexOf(': ');
      const title = colonIndex !== -1 ? line.slice(colonIndex + 2) : line;
      tasks.push({ id, title });
    }
  }
  return tasks;
}

/**
 * Map each `DR-N` requirement to the plan task ids that declare it via a
 * `**Implements:** DR-N[, DR-M]` annotation. This is the SAME coverage signal
 * `check_provenance_chain` uses (#1544) — wiring it here stops the traceability
 * matrix from contradicting the authoritative provenance gate by flagging
 * `### DR-N` design sections "Uncovered" when a task in fact implements them.
 */
function extractImplementsByDr(planContent: string): Map<string, readonly string[]> {
  const byDr = new Map<string, string[]>();
  let currentTaskId: string | null = null;
  for (const line of planContent.split('\n')) {
    const taskMatch = line.match(/^###\s+Task\s+(\d+)/);
    if (taskMatch) {
      currentTaskId = taskMatch[1];
      continue;
    }
    const implMatch = line.match(/\*\*Implements:\*\*\s*(.+)/i);
    if (implMatch && currentTaskId) {
      const drs = implMatch[1].match(/DR-\d+/gi) ?? [];
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

// ─── Table Generation ───────────────────────────────────────────────────────

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

    // #1544: if the section is (or names) a DR-N requirement, resolve coverage
    // via the plan's **Implements:** annotations first — the provenance signal —
    // so this matrix agrees with check_provenance_chain instead of false-flagging.
    const drMatch = section.name.match(/\bDR-\d+\b/i);
    if (drMatch) {
      matchedIds.push(...(implementsByDr.get(drMatch[0].toUpperCase()) ?? []));
    }

    // Otherwise find matching tasks by case-insensitive substring in task title
    if (matchedIds.length === 0) {
      for (const task of tasks) {
        if (task.title.toLowerCase().includes(section.name.toLowerCase())) {
          matchedIds.push(task.id);
        }
      }
    }

    // If still no matches, search plan body content
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

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleGenerateTraceability(args: GenerateTraceabilityArgs): ToolResult {
  // 1. Validate files exist
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

  // 2. Read files
  const designContent = readFileSync(args.designFile, 'utf-8') as string;
  const planContent = readFileSync(args.planFile, 'utf-8') as string;

  // 3. Extract design sections from the design REGION only (#1581 DR-6 task
  // 012): when design and plan are one unified artifact, scoping to the region
  // before the decomposition keeps `### Task` / `## Decomposition` headers out
  // of the design-section column. Plan tasks are still read from the FULL plan
  // content below.
  const sections = extractDesignSections(designRegion(designContent));
  if (sections.length === 0) {
    return {
      success: false,
      error: { code: 'NO_SECTIONS', message: 'No ## or ### headers found in design document' },
    };
  }

  // 4. Extract plan tasks
  const tasks = extractPlanTasks(planContent);

  // 5. Generate traceability table
  const { report, coveredCount, uncoveredCount } = generateTable(sections, tasks, planContent);

  // 6. Write to outputFile if specified
  if (args.outputFile) {
    writeFileSync(args.outputFile, report, 'utf-8');
  }

  // 7. Return result
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
