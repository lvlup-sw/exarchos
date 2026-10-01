/**
 * Provenance chain check. It matches the `DR-N` identifiers in a design document against the
 * `Implements:` fields of the plan tasks. It is pure string analysis.
 *
 * Status values:
 * - `pass`: each `DR-N` maps to at least one task.
 * - `fail`: an unmapped requirement or an orphan reference exists.
 * - `error`: a file is missing or unreadable, the design has no `DR-N`, or the plan has no tasks.
 */

import * as fs from 'node:fs';

export interface ProvenanceInput {
  /** Path to the design document markdown file. */
  readonly designFile: string;
  /** Path to the implementation plan markdown file. */
  readonly planFile: string;
}

export interface ProvenanceResult {
  /** Overall status: pass, fail, or error. */
  readonly status: 'pass' | 'fail' | 'error';
  /** Structured markdown report (stdout equivalent). */
  readonly output: string;
  /** Error message when status is 'error'. */
  readonly error?: string;
  /** Total number of unique DR-N identifiers in the design. */
  readonly requirements: number;
  /** Number of DR-N identifiers covered by plan tasks. */
  readonly covered: number;
  /** Number of DR-N identifiers not covered by any plan task. */
  readonly gaps: number;
  /** Number of DR-N references in the plan that the design does not define. */
  readonly orphanRefs: number;
  /** DR-N identifiers that are gaps (uncovered). */
  readonly gapDetails: readonly string[];
  /** DR-N orphan references with task context. */
  readonly orphanDetails: readonly string[];
}

interface TaskEntry {
  readonly title: string;
  readonly implements: readonly string[];
}

/**
 * The decomposition boundary in a unified spec artifact: the first `## Decomposition` or `## Tasks`
 * heading, or the first `### Task <id>:` header. The design region with the `DR-N` definitions is
 * before it. The task region with the `**Implements:** DR-N` references is after it.
 */
const DECOMPOSITION_BOUNDARY = /^(?:##\s+(?:Decomposition|Tasks)\b|###\s+Task\s+[A-Za-z0-9-]+:)/im;

/**
 * The design region of an artifact, which is the content before the decomposition boundary.
 *
 * When design and plan are one document, a whole-document scan reads the task references as `DR-N`
 * definitions. A task reference to an undefined `DR-N` then does not show as an orphan. A separate
 * design file has no boundary, so the whole file is the region.
 */
export function designRegion(content: string): string {
  const m = DECOMPOSITION_BOUNDARY.exec(content);
  return m ? content.slice(0, m.index) : content;
}

/**
 * Extract unique DR-N identifiers from a document, sorted numerically.
 */
function extractDesignRequirements(content: string): string[] {
  const matches = content.match(/\bDR-\d+\b/g);
  if (!matches) return [];

  const unique = [...new Set(matches)];
  unique.sort((a, b) => {
    const numA = parseInt(a.replace('DR-', ''), 10);
    const numB = parseInt(b.replace('DR-', ''), 10);
    return numA - numB;
  });
  return unique;
}

/**
 * Parses the plan tasks and their `DR-N` references. A task starts at a `### Task` header, and its
 * title is the text after the first `: `. References come from `Implements` or `implements` lines
 * inside the task.
 */
function extractPlanTasks(content: string): TaskEntry[] {
  const lines = content.split('\n');
  const tasks: TaskEntry[] = [];
  let currentTitle = '';
  let currentRefs: string[] = [];
  let inTask = false;

  for (const line of lines) {
    const taskMatch = line.match(/^###\s+Task\s/);
    if (taskMatch) {
      if (inTask && currentTitle) {
        tasks.push({ title: currentTitle, implements: currentRefs });
      }
      const colonIdx = line.indexOf(': ');
      currentTitle = colonIdx !== -1 ? line.slice(colonIdx + 2) : line;
      currentRefs = [];
      inTask = true;
      continue;
    }

    if (inTask) {
      const implMatch = line.match(/[Ii]mplements:?\s*(.*)/);
      if (implMatch) {
        const implText = implMatch[1] ?? '';
        const refs = implText.match(/DR-\d+/g);
        if (refs) {
          currentRefs.push(...refs);
        }
      }
    }
  }

  if (inTask && currentTitle) {
    tasks.push({ title: currentTitle, implements: currentRefs });
  }

  return tasks;
}

/**
 * Verifies the provenance chain between a design file and a plan file.
 *
 * Requirements come only from the design region, but tasks come from the full plan. A plan with no
 * `### Task` headers is an error, not a coverage gap, because the usual cause is a task heading at
 * the wrong level.
 */
export function verifyProvenanceChain(input: ProvenanceInput): ProvenanceResult {
  const errorResult = (error: string): ProvenanceResult => ({
    status: 'error',
    output: '',
    error,
    requirements: 0,
    covered: 0,
    gaps: 0,
    orphanRefs: 0,
    gapDetails: [],
    orphanDetails: [],
  });

  if (!fs.existsSync(input.designFile)) {
    return errorResult(`Design file not found: ${input.designFile}`);
  }
  if (!fs.existsSync(input.planFile)) {
    return errorResult(`Plan file not found: ${input.planFile}`);
  }

  let designContent: string;
  let planContent: string;
  try {
    designContent = fs.readFileSync(input.designFile, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to read design file: ${message}`);
  }
  try {
    planContent = fs.readFileSync(input.planFile, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to read plan file: ${message}`);
  }

  const designReqs = extractDesignRequirements(designRegion(designContent));
  if (designReqs.length === 0) {
    return errorResult('No DR-N identifiers found in design document');
  }

  const tasks = extractPlanTasks(planContent);

  if (tasks.length === 0) {
    return errorResult(
      "No '### Task' headers found in plan — 0 tasks parsed. Tasks must be " +
        "'### Task <id>: ...' (h3); grouping headings must be h2 or shallower. " +
        '(This is a parse issue, not a coverage gap.)',
    );
  }

  const gapDetails: string[] = [];
  const matrixRows: string[] = [];
  let covered = 0;

  for (const req of designReqs) {
    const matchedTasks: string[] = [];

    for (const task of tasks) {
      if (task.implements.includes(req)) {
        matchedTasks.push(task.title);
      }
    }

    if (matchedTasks.length > 0) {
      matrixRows.push(`| ${req} | ${matchedTasks.join(', ')} | Covered |`);
      covered++;
    } else {
      matrixRows.push(`| ${req} | — | **GAP** |`);
      gapDetails.push(req);
    }
  }

  const orphanDetails: string[] = [];
  const designReqSet = new Set(designReqs);

  for (const task of tasks) {
    for (const ref of task.implements) {
      if (!designReqSet.has(ref)) {
        const entry = `${ref} (in ${task.title})`;
        if (!orphanDetails.includes(entry)) {
          orphanDetails.push(entry);
        }
      }
    }
  }

  const gapCount = gapDetails.length;
  const orphanCount = orphanDetails.length;
  const total = designReqs.length;
  const hasIssues = gapCount > 0 || orphanCount > 0;

  const outputLines: string[] = [
    '## Provenance Chain Report',
    '',
    `**Design file:** \`${input.designFile}\``,
    `**Plan file:** \`${input.planFile}\``,
    '',
    '### Traceability Matrix',
    '',
    '| Requirement | Task(s) | Status |',
    '|-------------|---------|--------|',
    ...matrixRows,
    '',
    '### Summary',
    '',
    `- Requirements: ${total}`,
    `- Covered: ${covered}`,
    `- Gaps: ${gapCount}`,
    `- Orphan refs: ${orphanCount}`,
    '',
  ];

  if (gapCount > 0) {
    outputLines.push('### Unmapped Requirements');
    outputLines.push('');
    for (const gap of gapDetails) {
      outputLines.push(`- **${gap}** — No task implements this requirement`);
    }
    outputLines.push('');
  }

  if (orphanCount > 0) {
    outputLines.push('### Orphan References');
    outputLines.push('');
    for (const orphan of orphanDetails) {
      outputLines.push(`- **${orphan}** — References a requirement not found in design`);
    }
    outputLines.push('');
  }

  outputLines.push('---');
  outputLines.push('');

  if (hasIssues) {
    outputLines.push(
      `**Result: FAIL** (${gapCount}/${total} requirements unmapped, ${orphanCount} orphan references)`
    );
  } else {
    outputLines.push(`**Result: PASS** (${covered}/${total} requirements traced)`);
  }

  const output = outputLines.join('\n');

  return {
    status: hasIssues ? 'fail' : 'pass',
    output,
    requirements: total,
    covered,
    gaps: gapCount,
    orphanRefs: orphanCount,
    gapDetails,
    orphanDetails,
  };
}
