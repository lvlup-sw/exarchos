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

  for (const section of sections) {
    // Find matching tasks by case-insensitive substring match in task title
    const matchedIds: string[] = [];
    for (const task of tasks) {
      if (task.title.toLowerCase().includes(section.name.toLowerCase())) {
        matchedIds.push(task.id);
      }
    }

    // If no title matches, search plan body content
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

  // 3. Extract design sections
  const sections = extractDesignSections(designContent);
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
