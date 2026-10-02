/**
 * The task decomposition gate. It checks task structure, the dependency DAG, and parallel safety at
 * the boundary from plan to plan review.
 * The module also re-exports `canonicaliseTaskId` from `utils/task-id.ts`. It treats the `T-`, `T`,
 * and bare forms of one id number, with or without leading zeros, as the same task.
 */

import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from '../gates/gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from '../gates/gate-utils.js';
import { canonicaliseTaskId } from '../../utils/task-id.js';
import {
  assessDecompositionPlausibility,
  countBehaviors,
  extractBoundaryTouching,
  parseOverrides,
  type PlausibilityAssessment,
  type PlausibilityBaseline,
  type PlausibilityTaskInput,
} from './decomposition-plausibility.js';

interface TaskDecompositionArgs {
  readonly featureId: string;
  readonly planPath: string;
}

/** A parsed task block from a plan file. */
export interface TaskBlock {
  /** The task id from the header. */
  readonly id: string;
  /** Raw content of the task block (including the header line). */
  readonly content: string;
}

/** Result of validating a single task block's structure. */
export interface TaskStructureResult {
  readonly hasDescription: boolean;
  readonly descriptionWordCount: number;
  readonly hasFiles: boolean;
  readonly fileCount: number;
  readonly hasTests: boolean;
  readonly testCount: number;
  /**
   * The stamped risk tier of the task, if the block declares one. A `high` or unstamped task needs
   * tests to pass. A `low` or `medium` task does not.
   */
  readonly riskTier?: RiskTier;
  readonly status: 'PASS' | 'FAIL';
}

/** Result of DAG cycle detection. */
export interface DagValidationResult {
  readonly valid: boolean;
  readonly cyclePath?: string;
}

/** Input for DAG validation. */
export interface DagTask {
  readonly id: string;
  readonly deps: readonly string[];
}

/** Input for parallel safety check. */
export interface ParallelTask {
  readonly id: string;
  readonly isParallel: boolean;
  readonly files: readonly string[];
}

/** Result of parallel safety check. */
export interface ParallelSafetyResult {
  readonly safe: boolean;
  readonly conflicts: readonly string[];
}

interface TaskDecompositionResult {
  readonly passed: boolean;
  readonly wellDecomposed: number;
  readonly needsRework: number;
  readonly totalTasks: number;
  readonly dagValid: boolean;
  readonly parallelSafe: boolean;
  /**
   * Plausibility findings for the decomposition and the risk stamps. They are typed findings for the
   * caller, and they do not change `passed`.
   */
  readonly plausibility: PlausibilityAssessment;
  readonly report: string;
}

/**
 * The file extensions that `extractFiles` and `validateTaskStructure` accept as file paths. A token
 * with another suffix, such as the field reference `imageProvenance.isFirstParty` in prose, is not a
 * file. This prevents false parallel-safety conflicts. Both regexes use this one list.
 */
export const FILE_EXTENSION_ALLOWLIST: readonly string[] = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'yml',
  'yaml',
  'sh',
  'ps1',
  'sql',
  'kql',
  'bicep',
  'cs',
  'csproj',
  'sln',
  'go',
  'rs',
  'toml',
  /** Extensions of other source languages, such as the `.py` path of a pytest task. */
  'py',
  'rb',
  'java',
  'kt',
  'cpp',
  'tf',
];

/**
 * Regex source fragment matching a backtick-quoted file path whose suffix
 * is on `FILE_EXTENSION_ALLOWLIST`. The capture group brackets the path so
 * the same source compiles for both `match` (line-level scanning) and
 * `exec` (capture-group extraction) call sites.
 */
const FILE_PATH_PATTERN_SOURCE = `\`([a-zA-Z0-9_./-]+\\.(?:${FILE_EXTENSION_ALLOWLIST.join('|')}))\``;

/**
 * A task-header id token: an optional `T` or `T-` prefix, a leading digit, then digits, letters, dots,
 * or hyphens. The leading digit keeps a section header such as `### Task Structure` from reading as a task.
 * The token accepts numeric ids with or without the `T` prefix, and dotted sub-numbers such as `1.1`.
 * `parse-task-stamps.ts` also reads these numeric ids. That parser rejects a non-task header by its separator
 * and title, not by a leading digit. A header with no title or a letter-leading id reads differently there.
 */
const TASK_ID_TOKEN_SOURCE = String.raw`(?:T-?)?[0-9][0-9A-Za-z.\-]*`;

/**
 * A task header at heading depth 3 (`###`) or 4 (`####`). `Task\s+` requires whitespace, so the
 * section header `### Tasks` does not match. Group 1 captures the id.
 */
const TASK_HEADER_PATTERN = new RegExp(
  String.raw`^#{3,4}\s+Task\s+(${TASK_ID_TOKEN_SOURCE})`,
);

/** Matches a task heading line at either depth (id ignored). */
const TASK_HEADING_LINE = new RegExp(String.raw`^#{3,4}\s+Task\s+`);

/** Strips the `### Task <id>:` / `#### Task <id>:` prefix off a heading line. */
const TASK_HEADING_PREFIX = new RegExp(
  String.raw`^#{3,4}\s+Task\s+(?:${TASK_ID_TOKEN_SOURCE}):?\s*`,
);

/** Any markdown heading at task depth — terminates a description span. */
const TASK_DEPTH_HEADING = /^#{3,4}\s/;

/**
 * Extracts task blocks from plan markdown. A block starts at a `###` or `####` task header. It ends
 * at the next task header of either depth, or at the end of the content.
 */
export function parseTaskBlocks(content: string): TaskBlock[] {
  const lines = content.split('\n');
  const blocks: TaskBlock[] = [];

  let currentId: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = TASK_HEADER_PATTERN.exec(line);
    if (match) {
      if (currentId !== null) {
        blocks.push({ id: currentId, content: currentLines.join('\n') });
      }
      currentId = match[1] ?? null;
      currentLines = [line];
    } else if (currentId !== null) {
      currentLines.push(line);
    }
  }

  if (currentId !== null) {
    blocks.push({ id: currentId, content: currentLines.join('\n') });
  }

  return blocks;
}

/**
 * Extracts the description span of a task block as raw lines, before any word count.
 * The span starts with the prose tail of the task heading, without backtick spans. Thus a heading
 * that holds only file paths gives no description. The task-template shape puts its description there.
 *
 * The body part runs to the next task-depth heading or field header (`**Label:**`). A first
 * `**Goal:**` or `**Description:**` header does not end it. The span keeps the inline text of that
 * header and runs to the next field header. Thus a task that opens with `**Files:**` does not count
 * its file list as description.
 */
export function extractDescriptionSpan(lines: readonly string[]): string[] {
  const descLines: string[] = [];
  let firstFieldSeen = false;

  const firstLine = lines[0];
  const start = firstLine !== undefined && TASK_HEADING_LINE.test(firstLine) ? 1 : 0;
  if (start === 1 && firstLine !== undefined) {
    const headingTail = firstLine.replace(TASK_HEADING_PREFIX, '');
    const headingTailProse = headingTail.replace(/`[^`]*`/g, ' ').trim();
    if (headingTailProse.length > 0) {
      descLines.push(headingTailProse);
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (TASK_DEPTH_HEADING.test(line)) {
      break;
    }
    const fieldMatch = /^\*\*(\w[\w\s]*?):\*\*\s?(.*)$/.exec(line);
    if (fieldMatch) {
      const label = (fieldMatch[1] ?? '').trim();
      const isDescriptionIntroducer = /^(goal|description)$/i.test(label);
      if (firstFieldSeen) {
        break;
      }
      if (!isDescriptionIntroducer) {
        break;
      }
      firstFieldSeen = true;
      descLines.push(fieldMatch[2] ?? '');
      continue;
    }
    descLines.push(line);
  }

  return descLines;
}

/**
 * Checks a task block for description, file targets, and test expectations. A file target is a
 * backtick-quoted path with an extension on {@link FILE_EXTENSION_ALLOWLIST}. A test expectation is a
 * `[RED]` marker or a `Method_Scenario_Outcome` name.
 * The block passes with file targets, plus tests when the tier is `high` or absent. A `low` or
 * `medium` task needs no tests. The description word count is for information only.
 */
export function validateTaskStructure(block: string): TaskStructureResult {
  const lines = block.split('\n');

  const descText = extractDescriptionSpan(lines).join(' ');
  const descWords = descText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const descriptionWordCount = descWords.length;
  const hasDescription = descriptionWordCount > 10;

  const filePattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
  let fileCount = 0;
  for (const line of lines) {
    const matches = line.match(filePattern);
    if (matches) {
      fileCount += matches.length;
    }
  }
  const hasFiles = fileCount > 0;

  const redPattern = /\[RED\]/g;
  const msoPattern = /[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+/g;
  let testCount = 0;
  for (const line of lines) {
    const redMatches = line.match(redPattern);
    if (redMatches) {
      testCount += redMatches.length;
    } else {
      const msoMatches = line.match(msoPattern);
      if (msoMatches) {
        testCount += msoMatches.length;
      }
    }
  }
  const hasTests = testCount > 0;

  const riskTier = extractTaskRiskTier(block);
  const testsRequired = riskTier !== 'low' && riskTier !== 'medium';
  const status = hasFiles && (!testsRequired || hasTests) ? 'PASS' : 'FAIL';

  return {
    hasDescription,
    descriptionWordCount,
    hasFiles,
    fileCount,
    hasTests,
    testCount,
    ...(riskTier ? { riskTier } : {}),
    status,
  };
}

/**
 * Reads the stamped `riskTier` of a task block. It accepts `**riskTier:** high` and the template
 * spelling `**Risk Tier:** high`, with or without bold. The tier must follow the key and a colon, so
 * prose that names a tier word does not count. The tier word must end the token (`(?![\w-])`), so
 * `riskTier: low-priority` does not read as `low`.
 * It returns `undefined` when the block has no stamp, and then the task needs tests.
 */
function extractTaskRiskTier(block: string): RiskTier | undefined {
  const stamp = /risk\s*tier\*{0,2}\s*:\s*\*{0,2}\s*(low|medium|high)(?![\w-])/i;
  for (const line of block.split('\n')) {
    const match = stamp.exec(line);
    if (match && match[1] !== undefined) return match[1].toLowerCase() as RiskTier;
  }
  return undefined;
}

/**
 * The canonical-id lookup tables: the DFS visit state, the map back to the original id spelling for
 * messages, and the canonical adjacency.
 */
type CanonicalMaps = {
  readonly kind: 'ok';
  readonly visitState: Map<string, number>;
  readonly canonicalToOriginal: Map<string, string>;
  readonly depsMap: Map<string, readonly string[]>;
};

type CanonicalMapsError = {
  readonly kind: 'error';
  readonly result: DagValidationResult;
};

/** Builds the canonical-id tables. A duplicate id or an unresolved dependency stops the validation before the DFS. */
function buildCanonicalMaps(
  tasks: readonly DagTask[],
): CanonicalMaps | CanonicalMapsError {
  const visitState = new Map<string, number>();
  const canonicalToOriginal = new Map<string, string>();

  for (const task of tasks) {
    const canonical = canonicaliseTaskId(task.id);
    if (canonicalToOriginal.has(canonical)) {
      return {
        kind: 'error',
        result: { valid: false, cyclePath: `Duplicate task ID: ${task.id}` },
      };
    }
    visitState.set(canonical, 0);
    canonicalToOriginal.set(canonical, task.id);
  }

  const depsMap = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const canonicalSelf = canonicaliseTaskId(task.id);
    const canonicalDeps: string[] = [];
    for (const dep of task.deps) {
      const canonicalDep = canonicaliseTaskId(dep);
      if (!canonicalToOriginal.has(canonicalDep)) {
        return {
          kind: 'error',
          result: {
            valid: false,
            cyclePath: `Unresolved dependency: ${task.id} depends on unknown ${dep}`,
          },
        };
      }
      canonicalDeps.push(canonicalDep);
    }
    depsMap.set(canonicalSelf, canonicalDeps);
  }

  return { kind: 'ok', visitState, canonicalToOriginal, depsMap };
}

/**
 * An iterative DFS over the canonical adjacency from one root. It changes `visit` in place. It
 * returns the cycle edge in the original id spelling, or `null` for a clean traversal.
 * Each stack entry holds a phase: `enter` for descent and `exit` for the post-order mark. An
 * explicit stack has no depth limit on a large plan.
 */
function dfsCycleCheck(
  root: string,
  adj: ReadonlyMap<string, readonly string[]>,
  visit: Map<string, number>,
  canonicalToOriginal: ReadonlyMap<string, string>,
): DagValidationResult | null {
  const stack: Array<[string, 'enter' | 'exit']> = [[root, 'enter']];

  while (stack.length > 0) {
    const [node, phase] = stack.pop()!;

    if (phase === 'exit') {
      visit.set(node, 2);
      continue;
    }

    const state = visit.get(node);

    if (state === 2) {
      continue;
    }

    if (state === 1) {
      return { valid: false, cyclePath: canonicalToOriginal.get(node) ?? node };
    }

    visit.set(node, 1);
    stack.push([node, 'exit']);

    const deps = adj.get(node) ?? [];
    for (const dep of deps) {
      const depState = visit.get(dep);
      if (depState === 1) {
        const nodeOriginal = canonicalToOriginal.get(node) ?? node;
        const depOriginal = canonicalToOriginal.get(dep) ?? dep;
        return { valid: false, cyclePath: `${nodeOriginal} \u2192 ${depOriginal}` };
      }
      if (depState === 0) {
        stack.push([dep, 'enter']);
      }
    }
  }

  return null;
}

/**
 * Checks that the task dependency graph has no cycles. It compares canonical ids, so the forms of one
 * id number are the same task. Messages use the original id spelling.
 * Each node is unvisited (0), in progress on the DFS stack (1), or done (2). A node in progress means a cycle.
 */
export function validateDependencyDAG(tasks: readonly DagTask[]): DagValidationResult {
  const maps = buildCanonicalMaps(tasks);
  if (maps.kind === 'error') return maps.result;

  for (const task of tasks) {
    const canonicalRoot = canonicaliseTaskId(task.id);
    if (maps.visitState.get(canonicalRoot) !== 0) {
      continue;
    }
    const cycle = dfsCycleCheck(
      canonicalRoot,
      maps.depsMap,
      maps.visitState,
      maps.canonicalToOriginal,
    );
    if (cycle !== null) return cycle;
  }

  return { valid: true };
}

/**
 * Check for file conflicts between parallelizable tasks.
 *
 * Compares file lists between all pairs of tasks marked as parallel,
 * reporting any overlapping files.
 */
export function checkParallelSafety(tasks: readonly ParallelTask[]): ParallelSafetyResult {
  const parallelTasks = tasks.filter((t) => t.isParallel);
  const conflicts: string[] = [];

  for (let a = 0; a < parallelTasks.length; a++) {
    for (let b = a + 1; b < parallelTasks.length; b++) {
      const taskA = parallelTasks[a];
      const taskB = parallelTasks[b];
      if (taskA === undefined || taskB === undefined) continue;

      for (const fileA of taskA.files) {
        for (const fileB of taskB.files) {
          if (fileA === fileB) {
            conflicts.push(
              `CONFLICT: ${taskA.id} and ${taskB.id} both modify \`${fileA}\``,
            );
          }
        }
      }
    }
  }

  return {
    safe: conflicts.length === 0,
    conflicts,
  };
}

/**
 * Extracts dependency ids from the `**Dependencies:**` line of a task block, and from no other line.
 * It matches `T`-prefixed ids with or without a hyphen, and returns them verbatim.
 * `validateDependencyDAG` compares the canonical forms. It returns `[]` for `none`, an empty line,
 * or prose with no such id.
 */
export function extractDependencies(block: string): string[] {
  const lines = block.split('\n');
  for (const line of lines) {
    if (/^\*\*Dependencies:\*\*/.test(line)) {
      const depsLine = line.replace(/^\*\*Dependencies:\*\*\s*/, '').trim();
      if (!depsLine || /^none$/i.test(depsLine)) {
        return [];
      }
      const tRefs = depsLine.match(/\bT-?\d+\b/g);
      return tRefs ?? [];
    }
  }
  return [];
}

export { canonicaliseTaskId };

/**
 * Check if a task block is marked as parallelizable.
 */
function isParallelizable(block: string): boolean {
  const lines = block.split('\n');
  for (const line of lines) {
    if (/^\*\*Parallelizable:\*\*\s*[Yy]es/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts backtick-quoted file paths with an extension on {@link FILE_EXTENSION_ALLOWLIST}.
 * An explicit `**Files:**` section is authoritative, even when it declares no path. Thus `**Files:** none`
 * does not pick up unrelated backticks in the body. The section runs from the header line, inline
 * tail included, to the next task-depth heading or field header.
 * With no `**Files:**` section, the function scans the whole block.
 */
export function extractFiles(block: string): string[] {
  const lines = block.split('\n');
  const filesSectionLines: string[] = [];
  let inFilesSection = false;
  let sawFilesSection = false;
  for (const line of lines) {
    if (/^\*\*Files:\*\*/i.test(line)) {
      inFilesSection = true;
      sawFilesSection = true;
      const inlineTail = line.replace(/^\*\*Files:\*\*\s*/i, '');
      if (inlineTail.length > 0) {
        filesSectionLines.push(inlineTail);
      }
      continue;
    }
    if (inFilesSection) {
      if (TASK_DEPTH_HEADING.test(line) || /^\*\*\w[\w\s]*:\*\*/.test(line)) {
        inFilesSection = false;
        continue;
      }
      filesSectionLines.push(line);
    }
  }

  if (sawFilesSection) {
    const filesSection = filesSectionLines.join('\n');
    const declared: string[] = [];
    const sectionPattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
    let m: RegExpExecArray | null;
    while ((m = sectionPattern.exec(filesSection)) !== null) {
      if (m[1] !== undefined) declared.push(m[1]);
    }
    return declared;
  }

  const blockPattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g');
  const files: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(block)) !== null) {
    if (match[1] !== undefined) files.push(match[1]);
  }
  return files;
}

/**
 * Maps task blocks to the inputs of the plausibility assessor. It uses `extractFiles` and
 * `extractTaskRiskTier`, so the plausibility check and the structure check read the same files and tier.
 */
export function extractPlausibilityInputs(
  blocks: readonly TaskBlock[],
): PlausibilityTaskInput[] {
  return blocks.map((block) => {
    const riskTier = extractTaskRiskTier(block.content);
    const boundaryTouching = extractBoundaryTouching(block.content);
    return {
      id: block.id,
      files: extractFiles(block.content),
      behaviorCount: countBehaviors(block.content),
      ...(riskTier ? { riskTier } : {}),
      ...(boundaryTouching !== undefined ? { boundaryTouching } : {}),
      overrides: parseOverrides(block.content),
    };
  });
}

/**
 * Renders the plausibility assessment as a markdown section. An active challenge gives a `CHALLENGE`
 * line, and an overridden one gives an `OVERRIDDEN` line with its rationale.
 */
function renderPlausibilitySection(assessment: PlausibilityAssessment): string[] {
  const lines: string[] = ['### Decomposition Plausibility'];
  if (!assessment.challenged && assessment.overridden.length === 0) {
    lines.push('- No plausibility challenges \u2713');
    return lines;
  }
  for (const challenge of assessment.challenges) {
    lines.push(`- CHALLENGE (${challenge.signal}): ${challenge.message}`);
  }
  for (const overridden of assessment.overridden) {
    lines.push(
      `- OVERRIDDEN (${overridden.signal}): ${overridden.message} ` +
        `\u2014 rationale: ${overridden.overrideRationale}`,
    );
  }
  return lines;
}

/**
 * Runs the gate through the shared phase-gate runner, which records durable gate evidence before a
 * success carrier returns. A bare gate event append does not satisfy the declared postcondition.
 */
export async function handleTaskDecomposition(
  args: TaskDecompositionArgs,
  stateDir: string,
  eventStore: EventStore,
  baseline?: PlausibilityBaseline,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'task-decomposition',
    requirementId: 'requirement:task-decomposition',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'task-decomposition', phase: 'planning' },
      ),
    providerInput: args,
    executeProvider: async () =>
      executeTaskDecomposition(args, stateDir, eventStore, baseline),
  });
}

/**
 * Parses the plan markdown and checks the structure of each task, the dependency DAG, and parallel
 * safety. The plausibility findings go in the report and the result, but they do not change `passed`.
 * A `low` or `medium` task with no tests shows "n/a" in the Tests column, not a failure mark.
 * When the gate event append fails, it returns the failure from `requireGateEvent`.
 */
async function executeTaskDecomposition(
  args: TaskDecompositionArgs,
  _stateDir: string,
  eventStore: EventStore,
  baseline?: PlausibilityBaseline,
): Promise<ToolResult> {
  if (!args.planPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'planPath is required' },
    };
  }

  let planContent: string;
  try {
    planContent = await readFile(args.planPath, 'utf-8');
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: 'SCRIPT_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const blocks = parseTaskBlocks(planContent);

  if (blocks.length === 0) {
    return {
      success: false,
      error: {
        code: 'SCRIPT_ERROR',
        message: `No '### Task' / '#### Task' headers found in plan file: ${args.planPath}`,
      },
    };
  }

  let wellDecomposed = 0;
  let needsRework = 0;
  const structureRows: string[] = [];

  for (const block of blocks) {
    const result = validateTaskStructure(block.content);

    if (result.status === 'PASS') {
      wellDecomposed++;
    } else {
      needsRework++;
    }

    const descStatus = result.hasDescription
      ? `\u2713 (${result.descriptionWordCount} words)`
      : `\u2717 (${result.descriptionWordCount} words)`;
    const filesStatus = result.hasFiles
      ? `\u2713 (${result.fileCount} files)`
      : `\u2717 (0 files)`;
    const testsStatus = result.hasTests
      ? `\u2713 (${result.testCount} tests)`
      : result.riskTier === 'low' || result.riskTier === 'medium'
        ? `\u2014 (n/a: ${result.riskTier} tier)`
        : `\u2717 (0 tests)`;

    structureRows.push(
      `| ${block.id} | ${descStatus} | ${filesStatus} | ${testsStatus} | ${result.status} |`,
    );
  }

  const totalTasks = blocks.length;

  const dagTasks: DagTask[] = blocks.map((b) => ({
    id: b.id,
    deps: extractDependencies(b.content),
  }));
  const dagResult = validateDependencyDAG(dagTasks);

  const parallelTasks: ParallelTask[] = blocks.map((b) => ({
    id: b.id,
    isParallel: isParallelizable(b.content),
    files: extractFiles(b.content),
  }));
  const safetyResult = checkParallelSafety(parallelTasks);

  const reportLines: string[] = [
    '## Task Decomposition Report',
    '',
    `**Plan:** \`${args.planPath}\``,
    '',
    '### Task Structure',
    '',
    '| Task | Description | Files | Tests | Status |',
    '|------|-------------|-------|-------|--------|',
    ...structureRows,
    '',
    '### Dependency Analysis',
  ];

  if (dagResult.valid) {
    reportLines.push('- Dependency graph: valid DAG \u2713');
  } else {
    reportLines.push(`- Dependency graph: CYCLE DETECTED: ${dagResult.cyclePath ?? 'unknown'}`);
  }
  reportLines.push('');

  reportLines.push('### Parallel Safety');
  if (safetyResult.safe) {
    reportLines.push('- No file conflicts detected \u2713');
  } else {
    for (const conflict of safetyResult.conflicts) {
      reportLines.push(`- ${conflict}`);
    }
  }
  reportLines.push('');

  const plausibility = assessDecompositionPlausibility(
    extractPlausibilityInputs(blocks),
    {
      ...(baseline ? { baseline } : {}),
      planOverrides: parseOverrides(planContent),
    },
  );
  reportLines.push(...renderPlausibilitySection(plausibility));
  reportLines.push('');

  reportLines.push('### Summary');
  reportLines.push(`- Well-decomposed: ${wellDecomposed}/${totalTasks} tasks`);
  reportLines.push(`- Needs rework: ${needsRework}/${totalTasks} tasks`);
  reportLines.push(`- Dependency: ${dagResult.valid ? 'valid DAG' : 'CYCLE DETECTED'}`);
  reportLines.push(
    `- Parallel safety: ${safetyResult.safe ? 'clean' : `${safetyResult.conflicts.length} conflict(s)`}`,
  );
  reportLines.push(
    `- Plausibility: ${plausibility.challenged ? `${plausibility.challenges.length} challenge(s)` : 'clean'}`,
  );
  reportLines.push('');

  const passed = needsRework === 0 && dagResult.valid && safetyResult.safe;

  if (passed) {
    reportLines.push('**Result: PASS**');
  } else {
    reportLines.push(`**Result: FAIL** \u2014 ${needsRework} tasks need rework`);
  }

  const report = reportLines.join('\n');

  const result: TaskDecompositionResult = {
    passed,
    wellDecomposed,
    needsRework,
    totalTasks,
    dagValid: dagResult.valid,
    parallelSafe: safetyResult.safe,
    plausibility,
    report,
  };
  const carrier: ToolResult = { success: true, data: { ...result } };

  const store = eventStore;
  const unrecorded = await requireGateEvent(
    store,
    args.featureId,
    'task-decomposition',
    'planning',
    passed,
    carrier,
    {
      dimension: 'D5',
      phase: 'plan',
      wellDecomposed,
      needsRework,
      totalTasks,
    },
    sameOperationGateKey('task-decomposition'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
