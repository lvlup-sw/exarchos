/**
 * These tests run the gates on fixtures from the shipped authoring templates.
 * Each fixture comes from the fenced markdown blocks of a template, with
 * concrete values in place of the bracketed placeholders. A template edit
 * changes the fixture, so a template that drifts from its gate parser fails.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  handleDesignCompleteness,
  checkRequiredSections,
  checkMultipleOptions,
  checkAcceptanceCriteria,
} from '../../../src/verbs/pure/design-completeness.js';
import { verifyProvenanceChain } from '../../../src/verbs/pure/provenance-chain.js';
import {
  parseDesignSections,
  parsePlanTasks,
  parseDeferredSections,
  computeCoverage,
} from '../../../src/verbs/gates/plan-coverage.js';
import {
  parseTaskBlocks,
  validateTaskStructure,
  validateDependencyDAG,
  checkParallelSafety,
  extractDependencies,
  extractFiles,
  type DagTask,
  type ParallelTask,
} from '../../../src/verbs/tasks/task-decomposition.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The repo root, three levels up from `tests/unit/verbs`. The path comes from
 * `import.meta.url`, because `__dirname` is not defined under ESM.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const TEMPLATES = {
  design: resolve(REPO_ROOT, 'content/design/skills/ideate/references/design-template.md'),
  plan: resolve(REPO_ROOT, 'content/design/skills/plan/references/plan-document-template.md'),
  task: resolve(REPO_ROOT, 'content/design/skills/plan/references/task-template.md'),
} as const;

/**
 * Returns the body of each fenced markdown block in a template, in document
 * order and without the fence lines. The templates hold their example
 * documents in these blocks.
 */
function extractMarkdownBlocks(templateSrc: string): string[] {
  const blocks: string[] = [];
  const lines = templateSrc.split('\n');
  let inBlock = false;
  let current: string[] = [];

  for (const line of lines) {
    if (!inBlock && /^```markdown\s*$/.test(line.trim())) {
      inBlock = true;
      current = [];
      continue;
    }
    if (inBlock && /^```\s*$/.test(line.trim())) {
      inBlock = false;
      blocks.push(current.join('\n'));
      continue;
    }
    if (inBlock) {
      current.push(line);
    }
  }

  return blocks;
}

/**
 * Concrete values for the bracketed placeholders of the templates. The order
 * is most specific first, so a multi-word placeholder matches before the
 * generic `[N]` fallback.
 */
const PLACEHOLDER_SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\[N\]: \[Name\]/g, '1: Streaming validator'],
  [/\[2-3 sentence description\]/g, 'Validate each record as it streams in, rejecting malformed input early.'],
  [/\[Benefit 1\]/g, 'Low memory footprint'],
  [/\[Benefit 2\]/g, 'Fails fast on the first bad record'],
  [/\[Drawback 1\]/g, 'Harder to report all errors at once'],
  [/\[Drawback 2\]/g, 'Requires careful stream lifecycle handling'],
  [/\[Scenario where this option excels\]/g, 'Large inputs that must not be buffered'],
  [/\[Feature Name\]/g, 'Input Validation'],
  [/\[What we're solving and why\]/g, 'Malformed input currently crashes the importer; we must validate before processing.'],
  [/\[Selected option with rationale\]/g, 'Option 1 (streaming validator): bounded memory and fail-fast behavior fit our large inputs.'],
  [/### DR-1: \[Requirement name\]/g, '### DR-1: Validate required fields'],
  [/### DR-2: \[Requirement name\]/g, '### DR-2: Reject duplicate identifiers'],
  [/\[Description of the requirement\]/g, 'Every incoming record must carry all required fields before it is accepted.'],
  [/\[Description\]/g, 'Identifiers must be unique across the input set.'],
  [/\[Error\/failure\/boundary conditions\]/g, 'Empty input, truncated streams, and oversized records must be handled as errors, not crashes.'],
  [
    /\*\*Acceptance criteria:\*\*\n- \[Criterion 1\]\n- \[Criterion 2\]\n\n### DR-2/g,
    [
      '**Acceptance criteria:**',
      '- Given a record missing a required field',
      '  When the validator processes it',
      '  Then validation fails with a field-level error',
      '',
      '### DR-2',
    ].join('\n'),
  ],
  [
    /\*\*Acceptance criteria:\*\*\n- \[Criterion 1\]\n- \[Criterion 2\]\n\n### DR-N/g,
    [
      '**Acceptance criteria:**',
      '- Given two records sharing an identifier',
      '  When the validator processes the second',
      '  Then validation fails reporting the duplicate identifier',
      '',
      '### DR-N',
    ].join('\n'),
  ],
  [
    /\*\*Acceptance criteria:\*\*\n- \[Error case 1\]\n- \[Edge case 1\]/g,
    [
      '**Acceptance criteria:**',
      '- Given an empty or truncated input stream',
      '  When the validator runs',
      '  Then it reports an error and aborts without crashing',
    ].join('\n'),
  ],
  [/### DR-N: Error handling and edge cases/g, '### DR-3: Error handling and edge cases'],
  [/\[Implementation details, data structures, APIs\]/g, 'A streaming `Validator` class consuming records and emitting `ValidationError` on the first failure.'],
  [/\[How this connects to existing code\]/g, 'Wired into the existing importer pipeline ahead of the persistence step.'],
  [/\[How we'll verify it works\]/g, 'Unit tests per validation rule plus an integration test over a malformed fixture stream.'],
  [/\[Decisions deferred or needing input\]/g, 'None.'],
  [/# Implementation Plan: \[Feature Name\]/g, '# Implementation Plan: Input Validation'],
  [/Link: `docs\/designs\/YYYY-MM-DD-<feature>\.md`/g, 'Link: `docs/designs/2026-05-30-input-validation.md`'],
  [/\[Full design \| Partial: <specific components>\]/g, 'Full design'],
  [/\[None \| List excluded sections with rationale\]/g, 'None'],
  [/- Total tasks: \[N\]/g, '- Total tasks: 1'],
  [/- Parallel groups: \[N\]/g, '- Parallel groups: 1'],
  [/- Estimated test count: \[N\]/g, '- Estimated test count: 3'],
  [/- Design coverage: \[X of Y sections covered\]/g, '- Design coverage: 3 of 3 sections covered'],
  [/\[Traceability matrix from Step 1\.5\]/g, '| Design Section | Task | Status |\n|---|---|---|\n| DR-1: Validate required fields | T-01 | Covered |'],
  [/\[Tasks in execution order\]/g, '__TASK_BREAKDOWN__'],
  [/\[Which tasks can run in parallel worktrees\]/g, 'T-01 runs standalone.'],
  [/\[Open questions or design sections not addressed, with rationale\]/g, 'None.'],
  /**
   * The brief description sits in the task heading. The gate needs more than
   * 10 description words, so this value is long.
   */
  [
    /### Task \[N\]: \[Brief Description\]/g,
    '### Task 1: Validate that every required field is present on each incoming record before the importer accepts it',
  ],
  [/\*\*Phase:\*\* \[RED \| GREEN \| REFACTOR\]/g, '**Phase:** RED'],
  [/\*\*Test Layer:\*\* \[acceptance \| integration \| unit \| property\]/g, '**Test Layer:** unit'],
  [/\*\*Acceptance Test Ref:\*\* \[Task ID of parent acceptance test, or omit\]/g, '**Acceptance Test Ref:** none'],
  [/\*\*Implements:\*\* \[DR-N identifiers\]/g, '**Implements:** DR-1'],
  [/`TestName_Scenario_ExpectedOutcome`/g, '`Validate_MissingRequiredField_ReturnsError`'],
  [/path\/to\/test\.ts/g, 'src/validator.test.ts'],
  [/path\/to\/implementation\.ts/g, 'src/validator.ts'],
  [/\[Specific failure reason\]/g, 'no validator exists yet'],
  [/\[Brief description\]/g, 'add the required-field check'],
  [/\[SOLID principle or improvement\]/g, 'extract a reusable rule predicate'],
  [/\*\*Dependencies:\*\* \[Task IDs this depends on, or "None"\]/g, '**Dependencies:** None'],
  [/\*\*Parallelizable:\*\* \[Yes\/No\]/g, '**Parallelizable:** Yes'],
];

/** Applies `PLACEHOLDER_SUBSTITUTIONS` in order, then maps each remaining `[N]` to `1`. */
function substitutePlaceholders(block: string): string {
  let out = block;
  for (const [pattern, replacement] of PLACEHOLDER_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\[N\]/g, '1');
  return out;
}

/**
 * Reads a template, extracts its markdown blocks, substitutes the placeholders
 * in each block, and joins the blocks with `blockJoin`.
 */
function renderFromTemplate(templatePath: string, blockJoin = '\n\n'): {
  raw: string;
  blocks: string[];
  rendered: string;
} {
  const raw = readFileSync(templatePath, 'utf-8');
  const blocks = extractMarkdownBlocks(raw);
  const rendered = blocks.map(substitutePlaceholders).join(blockJoin);
  return { raw, blocks, rendered };
}

/**
 * The design template has three markdown blocks: the option format, the full
 * document structure, and a Given/When/Then example. The fixture uses the
 * first two blocks. The template has one example option, so the fixture adds a
 * second option for the two-option minimum of `checkMultipleOptions`.
 */
function deriveDesignFixture(): string {
  const { blocks } = renderFromTemplate(TEMPLATES.design);
  expect(blocks.length, 'design-template.md should ship 3 markdown example blocks').toBe(3);

  const optionBlockTemplate = blocks[0];
  const option1 = substitutePlaceholders(optionBlockTemplate);
  const option2 = substitutePlaceholders(optionBlockTemplate)
    .replace('### Option 1: Streaming validator', '### Option 2: Buffered validator')
    .replace(
      'Validate each record as it streams in, rejecting malformed input early.',
      'Buffer the whole input, then validate all records and report every error at once.',
    );

  const structure = substitutePlaceholders(blocks[1]);

  return [structure, '## Options Considered', '', option1, '', option2, ''].join('\n');
}

/**
 * Renders the one `### Task` block of the task template. A test checks it with
 * `validateTaskStructure`, and the plan fixture embeds it.
 */
function deriveTaskFixture(): string {
  const { blocks } = renderFromTemplate(TEMPLATES.task);
  expect(blocks.length, 'task-template.md should ship 1 markdown example block').toBe(1);
  return substitutePlaceholders(blocks[0]);
}

/**
 * Renders the plan template with the task block in place of the task
 * breakdown placeholder. As a result, the plan has a real task entry for the
 * coverage and decomposition gates.
 */
function derivePlanFixture(taskBlock: string): string {
  const { blocks } = renderFromTemplate(TEMPLATES.plan);
  expect(blocks.length, 'plan-document-template.md should ship 1 markdown example block').toBe(1);
  const rendered = substitutePlaceholders(blocks[0]);
  return rendered.replace('__TASK_BREAKDOWN__', taskBlock);
}

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmrf(tmpDir);
    tmpDir = undefined;
  }
});

function writeTmp(name: string, content: string): string {
  if (!tmpDir) {
    tmpDir = mkdtempSync(join(tmpdir(), 'template-roundtrip-'));
  }
  const p = join(tmpDir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('TemplateRoundTrip_ShippedTemplates_PassTheirGates', () => {
  describe('design-template.md → design-completeness', () => {
    it('DerivedDesign_AllSevenRequiredSectionsPresent', () => {
      const design = deriveDesignFixture();
      const result = checkRequiredSections(design);
      expect(
        result.passed,
        `design-template.md → checkRequiredSections drifted (missing: ${result.missing.join(', ')})`,
      ).toBe(true);
    });

    it('DerivedDesign_HasAtLeastTwoOptions', () => {
      const design = deriveDesignFixture();
      const result = checkMultipleOptions(design);
      expect(
        result.passed,
        `design-template.md → checkMultipleOptions drifted (found ${result.count} options)`,
      ).toBe(true);
    });

    /**
     * The gate must read the bold acceptance criteria header and the
     * Given/When/Then lines of the template.
     */
    it('DerivedDesign_EveryDrHasAcceptanceCriteria', () => {
      const design = deriveDesignFixture();
      const result = checkAcceptanceCriteria(design);
      expect(
        result.passed,
        `design-template.md → checkAcceptanceCriteria drifted (missing on: ${result.missingCriteria.join(', ')})`,
      ).toBe(true);
      expect(
        result.missingCriteria.length,
        'design-template.md → acceptance-criteria advisory should be EMPTY',
      ).toBe(0);
    });

    it('DerivedDesign_HandleDesignCompletenessPasses_NoAcceptanceAdvisory', () => {
      const design = deriveDesignFixture();
      const designFile = writeTmp('design.md', design);
      const result = handleDesignCompleteness({ designFile });
      expect(
        result.passed,
        'design-template.md → check_design_completeness drifted',
      ).toBe(true);
      const advisoryFinding = result.findings.find((f) => /missing acceptance criteria/i.test(f));
      expect(
        advisoryFinding,
        `design-template.md → unexpected acceptance-criteria advisory: ${advisoryFinding ?? ''}`,
      ).toBeUndefined();
    });
  });

  describe('design-template.md + plan-document-template.md → provenance-chain', () => {
    /**
     * The plan has one task, which implements the first requirement. The other
     * requirements are coverage gaps, not orphans. A parser drift shows as an
     * orphan reference or as an `error` status, so the test asserts neither.
     */
    it('DerivedDesignAndPlan_NoOrphanOrUncoveredDrs', () => {
      const design = deriveDesignFixture();
      const task = deriveTaskFixture();
      const plan = derivePlanFixture(task);
      const designFile = writeTmp('design.md', design);
      const planFile = writeTmp('plan.md', plan);

      const result = verifyProvenanceChain({ designFile, planFile });
      expect(
        result.status,
        `design+plan-template → provenance-chain failed to parse (status=${result.status}, error=${result.error ?? ''})`,
      ).not.toBe('error');
      expect(
        result.orphanRefs,
        `design+plan-template → provenance-chain reported orphan DR refs: ${result.orphanDetails.join('; ')}`,
      ).toBe(0);
      expect(
        result.covered,
        'design+plan-template → provenance-chain did not count the template task\'s DR-1 as covered',
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('design-template.md + plan-document-template.md → plan-coverage', () => {
    /**
     * The fixture has one task, so coverage is not full. The parsers must still
     * find the requirement sections and the task, and match at least one
     * section. Zero coverage means a parser drift.
     */
    it('DerivedDesignAndPlan_ComputeCoverageParsesSectionsAndTasks', () => {
      const design = deriveDesignFixture();
      const task = deriveTaskFixture();
      const plan = derivePlanFixture(task);

      const designSections = parseDesignSections(design);
      const tasks = parsePlanTasks(plan);
      const deferred = parseDeferredSections(plan);

      expect(
        designSections.length,
        'design-template.md → parseDesignSections found no DR subsections',
      ).toBeGreaterThanOrEqual(1);
      expect(
        tasks.length,
        'plan-document-template.md → parsePlanTasks found no `### Task` header',
      ).toBeGreaterThanOrEqual(1);

      const result = computeCoverage(designSections, tasks, plan, deferred, design);
      expect(
        result.coverage.total,
        'plan-coverage → computeCoverage produced zero total sections',
      ).toBeGreaterThanOrEqual(1);
      expect(
        result.coverage.covered,
        `plan-coverage → no design section matched the template task (gaps: ${result.gapSections.join(', ')})`,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('task-template.md → task-decomposition', () => {
    /**
     * The task template puts the brief description in the `### Task` heading
     * and starts the body with a phase field. The gate must read the heading
     * tail as the description.
     */
    it('DerivedTask_ValidateTaskStructure_WellDecomposed', () => {
      const task = deriveTaskFixture();
      const result = validateTaskStructure(task);
      expect(
        result.hasDescription,
        `task-template.md → validateTaskStructure lost the heading description (${result.descriptionWordCount} words)`,
      ).toBe(true);
      expect(
        result.hasFiles,
        `task-template.md → validateTaskStructure found no file targets (${result.fileCount} files)`,
      ).toBe(true);
      expect(
        result.hasTests,
        `task-template.md → validateTaskStructure found no test markers (${result.testCount} tests)`,
      ).toBe(true);
      expect(
        result.status,
        'task-template.md → check_task_decomposition marks the template task as needing rework',
      ).toBe('PASS');
    });

    it('DerivedTask_DependencyDagValid_AndParallelSafe', () => {
      const task = deriveTaskFixture();
      const plan = derivePlanFixture(task);
      const blocks = parseTaskBlocks(plan);
      expect(
        blocks.length,
        'plan-document-template.md → parseTaskBlocks found no task block',
      ).toBeGreaterThanOrEqual(1);

      const dagTasks: DagTask[] = blocks.map((b) => ({
        id: b.id,
        deps: extractDependencies(b.content),
      }));
      const dag = validateDependencyDAG(dagTasks);
      expect(
        dag.valid,
        `task-template.md → validateDependencyDAG drifted (cyclePath: ${dag.cyclePath ?? ''})`,
      ).toBe(true);

      const parallelTasks: ParallelTask[] = blocks.map((b) => ({
        id: b.id,
        isParallel: /\*\*Parallelizable:\*\*\s*[Yy]es/.test(b.content),
        files: extractFiles(b.content),
      }));
      const safety = checkParallelSafety(parallelTasks);
      expect(
        safety.safe,
        `task-template.md → checkParallelSafety drifted (conflicts: ${safety.conflicts.join('; ')})`,
      ).toBe(true);
    });
  });
});
