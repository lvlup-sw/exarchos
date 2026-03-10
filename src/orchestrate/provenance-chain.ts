/**
 * Provenance Chain Verification
 *
 * Validates design-to-plan traceability by cross-referencing DR-N identifiers
 * in design documents against Implements: fields in plan tasks.
 *
 * Port of scripts/verify-provenance-chain.sh — pure string analysis, no external tools.
 *
 * Exit code semantics (mapped to status field):
 *   'pass'  = complete traceability (every DR-N maps to >= 1 task)
 *   'fail'  = gaps found (unmapped requirements or orphan references)
 *   'error' = usage error (missing files, no DR-N identifiers)
 */

import * as fs from 'node:fs';

// ============================================================
// PUBLIC TYPES
// ============================================================

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
  /** Number of DR-N references in plan that don't exist in design. */
  readonly orphanRefs: number;
  /** DR-N identifiers that are gaps (uncovered). */
  readonly gapDetails: readonly string[];
  /** DR-N orphan references with task context. */
  readonly orphanDetails: readonly string[];
}

// ============================================================
// INTERNAL TYPES
// ============================================================

interface TaskEntry {
  readonly title: string;
  readonly implements: readonly string[];
}

// ============================================================
// EXTRACTION HELPERS
// ============================================================

/**
 * Extract unique DR-N identifiers from a document, sorted numerically.
 */
function extractDesignRequirements(content: string): string[] {
  const matches = content.match(/DR-\d+/g);
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
 * Parse plan tasks and extract their Implements: DR-N references.
 *
 * Looks for ### Task headers and case-insensitive Implements: lines.
 */
function extractPlanTasks(content: string): TaskEntry[] {
  const lines = content.split('\n');
  const tasks: TaskEntry[] = [];
  let currentTitle = '';
  let currentRefs: string[] = [];
  let inTask = false;

  for (const line of lines) {
    // Detect task header: ### Task ...
    const taskMatch = line.match(/^###\s+Task\s/);
    if (taskMatch) {
      // Save previous task
      if (inTask && currentTitle) {
        tasks.push({ title: currentTitle, implements: currentRefs });
      }
      // Extract title after "### Task N: "
      const colonIdx = line.indexOf(': ');
      currentTitle = colonIdx !== -1 ? line.slice(colonIdx + 2) : line;
      currentRefs = [];
      inTask = true;
      continue;
    }

    // Inside a task block, look for Implements: line (case insensitive)
    if (inTask) {
      const implMatch = line.match(/[Ii]mplements:?\s*(.*)/);
      if (implMatch) {
        const implText = implMatch[1];
        const refs = implText.match(/DR-\d+/g);
        if (refs) {
          currentRefs.push(...refs);
        }
      }
    }
  }

  // Save the last task
  if (inTask && currentTitle) {
    tasks.push({ title: currentTitle, implements: currentRefs });
  }

  return tasks;
}

// ============================================================
// MAIN FUNCTION
// ============================================================

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

  // Validate file existence
  if (!fs.existsSync(input.designFile)) {
    return errorResult(`Design file not found: ${input.designFile}`);
  }
  if (!fs.existsSync(input.planFile)) {
    return errorResult(`Plan file not found: ${input.planFile}`);
  }

  // Read files
  const designContent = fs.readFileSync(input.designFile, 'utf-8');
  const planContent = fs.readFileSync(input.planFile, 'utf-8');

  // Extract design requirements
  const designReqs = extractDesignRequirements(designContent);
  if (designReqs.length === 0) {
    return errorResult('No DR-N identifiers found in design document');
  }

  // Extract plan tasks
  const tasks = extractPlanTasks(planContent);

  // Cross-reference: design requirements to plan tasks
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

  // Detect orphan references
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

  // Build structured output
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
