// ─── Template → Gate Round-Trip Contract Shield (#1299) ──────────────────────
//
// This test loads the SHIPPED authoring templates from disk, DERIVES a minimal
// valid document from each template's fenced ```markdown example block(s) (by
// substituting bracketed [placeholders] with concrete values), and then runs
// every authoring gate's pure / markdown path against the derived fixture.
//
// Because each fixture is DERIVED FROM the live template text — not an inline
// hand-copy — editing a template changes this test's INPUT. If a future edit
// drifts a template away from what its gate parser expects, the matching
// assertion fails in CI immediately. This is the durable recurrence shield for
// the two Wave-1 drifts:
//   1. design-completeness — the template's standalone bold `**Acceptance
//      criteria:**` header and Given/When/Then continuation form.
//   2. task-decomposition — the template's brief-description-in-heading shape
//      (`### Task [N]: [Brief Description]` opening directly with `**Phase:**`).
//
// ADD-ONLY: this test touches no gate source and no template. If it surfaces a
// NEW drift beyond Wave-1, the offending assertion is `.skip`-ped with a
// `TODO(#1299)` note rather than weakening a gate — see the task brief.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

// ─── Repo-root resolution (ESM-safe) ─────────────────────────────────────────
//
// Mirror src/verbs/sidecar-backfill.test.ts:
// `__dirname` is undefined under NodeNext/ESM, so resolve REPO_ROOT from this
// test file's location via import.meta.url. This file lives at
// src/verbs/<this> → ../../../../ is the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const TEMPLATES = {
  design: resolve(REPO_ROOT, 'content/design/skills/ideate/references/design-template.md'),
  plan: resolve(REPO_ROOT, 'content/design/skills/plan/references/plan-document-template.md'),
  task: resolve(REPO_ROOT, 'content/design/skills/plan/references/task-template.md'),
} as const;

// ─── Fenced-block extraction ─────────────────────────────────────────────────

/**
 * Extract every fenced ```markdown … ``` block body from a template file.
 * Returns the inner text of each block (the fence lines themselves stripped),
 * in document order. The shipped templates wrap their canonical example
 * documents in such blocks; we derive our fixtures from these so a template
 * edit changes the fixture text.
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

// ─── Placeholder substitution ────────────────────────────────────────────────
//
// The point of this shield is that fixtures are DERIVED FROM the live template:
// we replace bracketed [placeholders] with concrete values. Substitutions are
// ordered most-specific-first so multi-word placeholders win over the generic
// "[N]"/"any bracket" fallbacks. Keep this map small and obvious — adding a new
// template later should only require a couple of entries here.
const PLACEHOLDER_SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Design — option block
  [/\[N\]: \[Name\]/g, '1: Streaming validator'],
  [/\[2-3 sentence description\]/g, 'Validate each record as it streams in, rejecting malformed input early.'],
  [/\[Benefit 1\]/g, 'Low memory footprint'],
  [/\[Benefit 2\]/g, 'Fails fast on the first bad record'],
  [/\[Drawback 1\]/g, 'Harder to report all errors at once'],
  [/\[Drawback 2\]/g, 'Requires careful stream lifecycle handling'],
  [/\[Scenario where this option excels\]/g, 'Large inputs that must not be buffered'],
  // Design — document structure
  [/\[Feature Name\]/g, 'Input Validation'],
  [/\[What we're solving and why\]/g, 'Malformed input currently crashes the importer; we must validate before processing.'],
  [/\[Selected option with rationale\]/g, 'Option 1 (streaming validator): bounded memory and fail-fast behavior fit our large inputs.'],
  // DR-1
  [/### DR-1: \[Requirement name\]/g, '### DR-1: Validate required fields'],
  // DR-2
  [/### DR-2: \[Requirement name\]/g, '### DR-2: Reject duplicate identifiers'],
  [/\[Description of the requirement\]/g, 'Every incoming record must carry all required fields before it is accepted.'],
  [/\[Description\]/g, 'Identifiers must be unique across the input set.'],
  [/\[Error\/failure\/boundary conditions\]/g, 'Empty input, truncated streams, and oversized records must be handled as errors, not crashes.'],
  // Acceptance-criteria bodies (Given/When/Then for behavioral DRs)
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
  // DR-N error/edge-case heading → concrete error/edge DR-3
  [/### DR-N: Error handling and edge cases/g, '### DR-3: Error handling and edge cases'],
  // Design — body sections
  [/\[Implementation details, data structures, APIs\]/g, 'A streaming `Validator` class consuming records and emitting `ValidationError` on the first failure.'],
  [/\[How this connects to existing code\]/g, 'Wired into the existing importer pipeline ahead of the persistence step.'],
  [/\[How we'll verify it works\]/g, 'Unit tests per validation rule plus an integration test over a malformed fixture stream.'],
  [/\[Decisions deferred or needing input\]/g, 'None.'],
  // Plan-document placeholders
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
  // Task-template placeholders (the `### Task` block). The brief description
  // lives IN the heading (the Wave-1 shape); the gate requires the description
  // span to exceed 10 words, so the concrete value must be long enough on its
  // own — the heading tail is the only description signal for this shape.
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

/**
 * Apply the placeholder substitutions to a derived block. Any residual generic
 * `[N]` is mapped to `1` last (after the structural substitutions above have
 * consumed the meaningful brackets).
 */
function substitutePlaceholders(block: string): string {
  let out = block;
  for (const [pattern, replacement] of PLACEHOLDER_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  // Generic trailing fallback for any bare numeric placeholder.
  out = out.replace(/\[N\]/g, '1');
  return out;
}

// ─── renderFromTemplate ──────────────────────────────────────────────────────
//
// Single, well-commented helper that turns a shipped template into a minimal
// valid fixture. Adding a gate/template later is a one-line change: read the
// template, extract its ```markdown blocks, substitute placeholders, join.
// `blockJoin` lets callers stitch multiple example blocks (e.g. the design
// template's "options" block + "structure" block) into one document.
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

// ─── Derived fixtures ────────────────────────────────────────────────────────

/**
 * Design fixture. The design template ships THREE ```markdown blocks: the
 * option format (one `### Option [N]` block), the full document structure (all
 * 7 sections + the DR blocks), and a small Given/When/Then format illustration
 * under "Requirement Format Rules". We use blocks[0] and blocks[1] for the
 * fixture and intentionally ignore the GWT illustration (blocks[2]); we also
 * duplicate the option block with N=1/N=2 so the design satisfies
 * `checkMultipleOptions`'s ">= 2 options" requirement — the template only ships
 * one example option.
 */
function deriveDesignFixture(): string {
  const { blocks } = renderFromTemplate(TEMPLATES.design);
  // blocks[0] = option-format example, blocks[1] = full document structure,
  // blocks[2] = GWT format illustration (unused by this fixture).
  expect(blocks.length, 'design-template.md should ship 3 markdown example blocks').toBe(3);

  const optionBlockTemplate = blocks[0];
  const option1 = substitutePlaceholders(optionBlockTemplate);
  // Second option: re-derive from the same template block, but renumber the
  // heading/name so we get a genuinely distinct `### Option 2`.
  const option2 = substitutePlaceholders(optionBlockTemplate)
    .replace('### Option 1: Streaming validator', '### Option 2: Buffered validator')
    .replace(
      'Validate each record as it streams in, rejecting malformed input early.',
      'Buffer the whole input, then validate all records and report every error at once.',
    );

  const structure = substitutePlaceholders(blocks[1]);

  // Splice the two options into the document under Chosen Approach so the
  // single rendered document carries >= 2 `### Option N` headings AND all 7
  // required `## ` sections.
  return [structure, '## Options Considered', '', option1, '', option2, ''].join('\n');
}

/**
 * Task fixture — the single `### Task` block from task-template.md, rendered
 * with concrete values. This is the exact shape the task-decomposition gate's
 * `validateTaskStructure` must accept (the Wave-1 brief-description-in-heading
 * fix). Returned standalone so it can be both validated directly AND embedded
 * into the plan document under "## Task Breakdown".
 */
function deriveTaskFixture(): string {
  const { blocks } = renderFromTemplate(TEMPLATES.task);
  expect(blocks.length, 'task-template.md should ship 1 markdown example block').toBe(1);
  return substitutePlaceholders(blocks[0]);
}

/**
 * Plan fixture — the plan-document-template.md example, with the `## Task
 * Breakdown` placeholder replaced by the derived task block so the plan
 * carries a real `### Task 1: …` entry for the coverage/decomposition gates.
 */
function derivePlanFixture(taskBlock: string): string {
  const { blocks } = renderFromTemplate(TEMPLATES.plan);
  expect(blocks.length, 'plan-document-template.md should ship 1 markdown example block').toBe(1);
  const rendered = substitutePlaceholders(blocks[0]);
  return rendered.replace('__TASK_BREAKDOWN__', taskBlock);
}

// ─── tmp-file scaffolding (mirrors design-completeness.test.ts) ──────────────

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TemplateRoundTrip_ShippedTemplates_PassTheirGates', () => {
  // ─── design-template.md → check_design_completeness ─────────────────────────

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

    it('DerivedDesign_EveryDrHasAcceptanceCriteria', () => {
      const design = deriveDesignFixture();
      const result = checkAcceptanceCriteria(design);
      expect(
        result.passed,
        `design-template.md → checkAcceptanceCriteria drifted (missing on: ${result.missingCriteria.join(', ')})`,
      ).toBe(true);
      // Wave-1 shield: the acceptance-criteria advisory MUST be empty — the
      // template's standalone bold `**Acceptance criteria:**` header + GWT
      // continuation form must be recognized.
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
      // No "missing acceptance criteria" advisory finding should appear.
      const advisoryFinding = result.findings.find((f) => /missing acceptance criteria/i.test(f));
      expect(
        advisoryFinding,
        `design-template.md → unexpected acceptance-criteria advisory: ${advisoryFinding ?? ''}`,
      ).toBeUndefined();
    });
  });

  // ─── design + plan → provenance-chain ───────────────────────────────────────

  describe('design-template.md + plan-document-template.md → provenance-chain', () => {
    it('DerivedDesignAndPlan_NoOrphanOrUncoveredDrs', () => {
      const design = deriveDesignFixture();
      const task = deriveTaskFixture();
      const plan = derivePlanFixture(task);
      const designFile = writeTmp('design.md', design);
      const planFile = writeTmp('plan.md', plan);

      const result = verifyProvenanceChain({ designFile, planFile });
      // The derived plan ships one task implementing DR-1. DR-2 and DR-3 exist
      // in the design but have no covering task in this minimal fixture, so
      // they are legitimate (uncovered) gaps — NOT orphans. Provenance "fail"
      // here would be a coverage gap, not a parser drift. The drift signal we
      // guard is ORPHAN refs (a plan DR-N the design never declared) and a
      // parse `error` (no DR-N parsed at all). Assert those are clean.
      expect(
        result.status,
        `design+plan-template → provenance-chain failed to parse (status=${result.status}, error=${result.error ?? ''})`,
      ).not.toBe('error');
      expect(
        result.orphanRefs,
        `design+plan-template → provenance-chain reported orphan DR refs: ${result.orphanDetails.join('; ')}`,
      ).toBe(0);
      // The one declared task's DR (DR-1) must be recognized as covered.
      expect(
        result.covered,
        'design+plan-template → provenance-chain did not count the template task\'s DR-1 as covered',
      ).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── design + plan → plan-coverage ──────────────────────────────────────────

  describe('design-template.md + plan-document-template.md → plan-coverage', () => {
    it('DerivedDesignAndPlan_ComputeCoverageParsesSectionsAndTasks', () => {
      const design = deriveDesignFixture();
      const task = deriveTaskFixture();
      const plan = derivePlanFixture(task);

      const designSections = parseDesignSections(design);
      const tasks = parsePlanTasks(plan);
      const deferred = parseDeferredSections(plan);

      // Parser-drift signal: the gate must still find the design's DR
      // subsections and the plan's `### Task 1:` header from the template
      // shapes. Empty parses here would be the drift we are shielding against.
      expect(
        designSections.length,
        'design-template.md → parseDesignSections found no DR subsections',
      ).toBeGreaterThanOrEqual(1);
      expect(
        tasks.length,
        'plan-document-template.md → parsePlanTasks found no `### Task` header',
      ).toBeGreaterThanOrEqual(1);

      const result = computeCoverage(designSections, tasks, plan, deferred, design);
      // The minimal fixture ships ONE task (covering DR-1) against three DR
      // sections, so a full-coverage pass is not expected. We assert the gate
      // RAN and matched the one declared task's section — i.e. coverage > 0,
      // not all-GAP. A total wipe-out (covered === 0) would indicate the
      // section/task parsers drifted out of lockstep with the templates.
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

  // ─── task-template.md → task-decomposition ──────────────────────────────────

  describe('task-template.md → task-decomposition', () => {
    it('DerivedTask_ValidateTaskStructure_WellDecomposed', () => {
      const task = deriveTaskFixture();
      const result = validateTaskStructure(task);
      // Wave-1 shield: the task template puts the brief description IN the
      // `### Task [N]: …` heading and opens the body with `**Phase:**` (a
      // non-description field). Before the fix this scored 0 description words
      // and hard-FAILED. The heading-tail derivation must keep it passing.
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
