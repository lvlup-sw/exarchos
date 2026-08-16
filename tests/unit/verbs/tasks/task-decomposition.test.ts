import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock dependencies before importing the module under test
vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
}));

// Stub EventStore for handler injection
const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
};

// We mock fs/promises for handleTaskDecomposition integration test
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

import { readFile } from 'node:fs/promises';
import type { EventStore } from '../../../../src/events/store.js';
import { emitGateEvent } from '../../../../src/verbs/gates/gate-utils.js';
import {
  parseTaskBlocks,
  validateTaskStructure,
  validateDependencyDAG,
  checkParallelSafety,
  handleTaskDecomposition,
  extractDependencies,
  extractFiles,
} from '../../../../src/verbs/tasks/task-decomposition.js';

const mockedEmitGateEvent = vi.mocked(emitGateEvent);
const mockedReadFile = vi.mocked(readFile);

// ─── Fixture Data ─────────────────────────────────────────────────────────

const WELL_DECOMPOSED_PLAN = `# Implementation Plan

## Tasks

### Task T-01: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- \`src/components/widget.ts\`
- \`src/components/widget.test.ts\`

**Tests:**
- [RED] \`Widget_Render_DisplaysContent\` -- verify widget renders content
- [RED] \`Widget_EmptyData_ShowsPlaceholder\` -- verify empty state

**Dependencies:** None
**Parallelizable:** No

### Task T-02: Create the API client module for backend communication

**Description:** Implement the HTTP client wrapper that handles authentication headers, retry logic, and response parsing for all backend API calls in the application.

**Files:**
- \`src/api/client.ts\`
- \`src/api/client.test.ts\`

**Tests:**
- [RED] \`ApiClient_Fetch_ReturnsData\` -- verify data fetching
- [RED] \`ApiClient_Error_ThrowsHttpError\` -- verify error handling
- [RED] \`ApiClient_Retry_AttemptsThreeTimes\` -- verify retry logic

**Dependencies:** None
**Parallelizable:** Yes

### Task T-03: Create the state manager for application state

**Description:** Build the centralized state management module that handles all application state transitions, subscriptions, and persistence using an event-sourced architecture pattern.

**Files:**
- \`src/state/manager.ts\`
- \`src/state/manager.test.ts\`

**Tests:**
- [RED] \`StateManager_Set_UpdatesState\` -- verify state update
- [RED] \`StateManager_Subscribe_NotifiesListeners\` -- verify subscriptions

**Dependencies:** T-01, T-02
**Parallelizable:** No
`;

const NUMERIC_FORMAT_PLAN = `# Implementation Plan

## Tasks

### Task 1: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- \`src/components/widget.ts\`
- \`src/components/widget.test.ts\`

**Tests:**
- [RED] \`Widget_Render_DisplaysContent\` -- verify widget renders content

**Dependencies:** None
**Parallelizable:** No

### Task 2: Create the API client module for backend communication

**Description:** Implement the HTTP client wrapper that handles authentication headers, retry logic, and response parsing for all backend API calls in the application.

**Files:**
- \`src/api/client.ts\`
- \`src/api/client.test.ts\`

**Tests:**
- [RED] \`ApiClient_Fetch_ReturnsData\` -- verify data fetching
- [RED] \`ApiClient_Error_ThrowsHttpError\` -- verify error handling

**Dependencies:** Task 1
**Parallelizable:** Yes
`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe('parseTaskBlocks', () => {
  it('ParseTaskBlocks_StandardFormat_ExtractsBlocks', () => {
    const blocks = parseTaskBlocks(WELL_DECOMPOSED_PLAN);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].id).toBe('T-01');
    expect(blocks[1].id).toBe('T-02');
    expect(blocks[2].id).toBe('T-03');
    // Each block should contain its content
    expect(blocks[0].content).toContain('widget rendering component');
    expect(blocks[1].content).toContain('HTTP client wrapper');
  });

  it('ParseTaskBlocks_NumericFormat_ExtractsBlocks', () => {
    const blocks = parseTaskBlocks(NUMERIC_FORMAT_PLAN);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe('1');
    expect(blocks[1].id).toBe('2');
    expect(blocks[0].content).toContain('widget rendering component');
    expect(blocks[1].content).toContain('HTTP client wrapper');
  });
});

// ─── #1670 (DR-5): parse the majority-4-hash `docs/specs/` corpus ─────────────
//
// The gate-path `parseTaskBlocks`/`extractTaskRiskTier` matched only `### Task`
// (three hashes). But the real corpus is majority `#### Task` (four hashes) —
// 7 of 11 specs are 4-hash-only — so `extractTaskRiskTier` silently dropped
// tiers on MOST live specs. The parser now accepts BOTH `###` and `####` and the
// broader id token used by the SoT dispatch parser (`parse-task-stamps.ts`),
// WITHOUT regressing the legacy `### Task NNN` / `T-NN` form.
//
// REPO_ROOT resolution mirrors template-roundtrip.test.ts: `__dirname` is
// undefined under NodeNext/ESM, so resolve from this file's URL. This file lives
// at src/verbs/tasks/<this> → ../../../../.. is the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FOUR_HASH_CORPUS_SPEC = resolve(
  REPO_ROOT,
  'docs/specs/2026-07-03-wlm-reconcile-enforce.md',
);

describe('parseTaskBlocks — #1670 majority-4-hash corpus (DR-5)', () => {
  it.skipIf(!existsSync(FOUR_HASH_CORPUS_SPEC))('ParseTaskBlocks_FourHashCorpusSpec_ExtractsTiers', () => {
    // Parse a REAL 4-hash-only corpus spec off disk. The OLD three-hash-only
    // pattern matched NONE of its `#### Task` headers (0 blocks → 0 tiers); the
    // fixed parser finds every task and extracts its `**Risk Tier:**` stamp.
    const specPath = FOUR_HASH_CORPUS_SPEC;
    const content = readFileSync(specPath, 'utf-8');

    // Contrast oracle: the pre-#1670 header pattern found zero headers here.
    const OLD_PATTERN = /^###\s+Task\s+(T-[0-9]+|[0-9]+)/;
    const oldHeaderMatches = content.split('\n').filter((l) => OLD_PATTERN.test(l));
    expect(oldHeaderMatches).toHaveLength(0);

    // Self-referential count so the assertion survives future edits to the spec.
    const fourHashHeaderCount = content
      .split('\n')
      .filter((l) => /^####\s+Task\s/.test(l)).length;
    expect(fourHashHeaderCount).toBeGreaterThanOrEqual(20); // this spec is 4-hash-only

    const blocks = parseTaskBlocks(content);
    expect(blocks.length).toBe(fourHashHeaderCount); // fixed parser finds them all (old: 0)

    // Every task in this spec carries a `**Risk Tier:**` stamp; extraction now
    // reaches all of them where the old parser reached none.
    const tiered = blocks.filter(
      (b) => validateTaskStructure(b.content).riskTier !== undefined,
    );
    expect(tiered.length).toBe(blocks.length);
    expect(tiered.length).toBeGreaterThan(0);
  });

  it('ParseTaskBlocks_ThreeHashLegacyId_StillParses', () => {
    // Characterization: the legacy 3-hash `### Task` form (both `T-NN` and bare
    // numeric ids) parses exactly as before — ids preserved, tiers extracted.
    // The #1670 change must not regress it.
    const plan = [
      '### Task T-01: Legacy hyphen id form kept intact',
      '',
      '**Risk Tier:** medium',
      '',
      '**Files:**',
      '- `src/a.ts`',
      '',
      '### Task 2: Legacy bare-numeric id form kept intact',
      '',
      '**Risk Tier:** high',
      '',
      '**Files:**',
      '- `src/b.ts`',
      '',
    ].join('\n');

    const blocks = parseTaskBlocks(plan);
    expect(blocks.map((b) => b.id)).toEqual(['T-01', '2']);
    expect(validateTaskStructure(blocks[0].content).riskTier).toBe('medium');
    expect(validateTaskStructure(blocks[1].content).riskTier).toBe('high');
  });

  // Property/matrix: heading depth ∈ {3,4} × id ∈ {`T-NN`, `NN`} — all four
  // combinations parse to exactly one block with the id preserved and the tier
  // extracted. Binds directly to the header-pattern fix: three of the four rows
  // (every `####` row, plus the broadened-id contract) were unreachable before.
  it.each([
    ['###', 'T-07'],
    ['###', '07'],
    ['####', 'T-07'],
    ['####', '07'],
  ] as const)(
    'ParseTaskBlocks_Depth-%s_Id-%s_ParsesWithTier',
    (depth, id) => {
      const plan = [
        `${depth} Task ${id}: Do the bounded thing that must be verified`,
        '',
        '**Risk Tier:** high',
        '',
        '**Files:**',
        '- `src/x.ts`',
        '',
      ].join('\n');

      const blocks = parseTaskBlocks(plan);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].id).toBe(id);
      expect(validateTaskStructure(blocks[0].content).riskTier).toBe('high');
    },
  );

  it('ValidateTaskStructure_FourHashHeading_DoesNotCountHeadingPrefixAsDescription', () => {
    // #1670: for a `####` heading the `#### Task NNN:` prefix must be stripped
    // before the tail counts as description. The OLD 3-hash-only span parser
    // left the prefix in, inflating the count by three tokens (`####`, `Task`,
    // `NNN:`) and mis-crediting the heading. Here the genuine tail is 9 words
    // (< the 10-word threshold): the fixed parser reports 9 / no-description
    // and reads the tier; the old parser reported 12 / has-description.
    const block = [
      '#### Task 007: Author the streaming validator that rejects malformed rows early',
      '**Risk Tier:** medium',
    ].join('\n');

    const result = validateTaskStructure(block);
    expect(result.descriptionWordCount).toBe(9);
    expect(result.hasDescription).toBe(false);
    expect(result.riskTier).toBe('medium');
  });

  it('ValidateTaskStructure_FourHashTemplateShape_CreditsHeadingDescription', () => {
    // Symmetry with the 3-hash `ValidateTaskStructure_TemplateShapedTask_...`
    // contract (T-02/#1486): a 4-hash template-shaped task whose brief
    // description lives in the heading and whose body opens with a
    // non-introducer field is credited via the stripped heading tail.
    const block = [
      '#### Task 001: Wrap the prune-executor remove path with a bounded index-lock retry adapter so transient contention never aborts a prune',
      '**Risk Tier:** high · **Boundary Touching:** true',
      '**Files:**',
      '- `src/manager.ts`',
      '- `src/manager.test.ts`',
      '**Verification:** high ladder. Tests: `Prune_Contention_Retries`.',
    ].join('\n');

    const result = validateTaskStructure(block);
    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    expect(result.hasFiles).toBe(true);
    expect(result.hasTests).toBe(true);
    expect(result.riskTier).toBe('high');
    expect(result.status).toBe('PASS');
  });
});

describe('validateTaskStructure', () => {
  it('ValidateTaskStructure_CompleteTask_Passes', () => {
    const block = `### Task T-01: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- \`src/components/widget.ts\`
- \`src/components/widget.test.ts\`

**Tests:**
- [RED] \`Widget_Render_DisplaysContent\` -- verify widget renders content
- [RED] \`Widget_EmptyData_ShowsPlaceholder\` -- verify empty state

**Dependencies:** None
**Parallelizable:** No`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(true);
    expect(result.hasFiles).toBe(true);
    expect(result.hasTests).toBe(true);
    expect(result.status).toBe('PASS');
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    expect(result.fileCount).toBe(2);
    expect(result.testCount).toBeGreaterThanOrEqual(2);
  });

  // ─── #1544: drop word-count hard-FAIL; recognize non-JS/TS file paths ──────
  it('ValidateTaskStructure_ShortDescriptionWithFilesAndTests_DoesNotFailOnWordCount', () => {
    // Files + tests present, but a short (<10-word) description. Previously the
    // word-count threshold hard-FAILED this (the 40/40 false-FAIL in #1544).
    const block = `### Task T-30: Short title task

**Files:**
- \`src/foo.ts\`

**Tests:**
- [RED] \`Foo_Bar_Baz\`
`;
    const result = validateTaskStructure(block);
    expect(result.hasFiles).toBe(true);
    expect(result.hasTests).toBe(true);
    expect(result.status).toBe('PASS');
  });

  it('ValidateTaskStructure_PythonFilePath_CountedAsFile', () => {
    // #1544: a pytest task's `.py` path was not recognized (✗ 0 files).
    const block = `### Task T-30: pytest emit harness

**Description:** Build the emit harness that exercises the sandbox pipeline end to end.

**Files:**
- \`apps/sandbox/harness/emit_harness.py\`

**Tests:**
- [RED] \`Harness_Emit_ProducesOutput\`
`;
    const result = validateTaskStructure(block);
    expect(result.fileCount).toBeGreaterThanOrEqual(1);
    expect(result.hasFiles).toBe(true);
  });

  it('ValidateTaskStructure_MissingDescription_ReportsGracefully', () => {
    const block = `### Task T-01: Widget component

**Files:**
- \`src/components/widget.ts\`

**Tests:**
- [RED] \`Widget_Render_DisplaysContent\`

**Dependencies:** None
**Parallelizable:** No`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(false);
    // Should report 0 description words (no **Description:** field found)
    expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
  });

  it('ValidateTaskStructure_BlankLinesInDescription_CountsAllWords', () => {
    const block = `### Task T-01: Create widget

**Description:** Build the widget rendering component that handles all display
logic including template compilation.

This component also manages DOM updates for the main dashboard view and
provides event hooks for lifecycle management.

**Files:**
- \`src/components/widget.ts\`

**Tests:**
- [RED] \`Widget_Render_DisplaysContent\`

**Dependencies:** None`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(true);
    // Should count words across blank lines: both paragraphs
    expect(result.descriptionWordCount).toBeGreaterThan(15);
  });

  it('ValidateTaskStructure_MethodScenarioOutcome_DetectsTests', () => {
    const block = `### Task T-01: Create widget

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- \`src/components/widget.ts\`
- \`src/components/widget.test.ts\`

Test names:
- Widget_Render_DisplaysContent
- Widget_EmptyData_ShowsPlaceholder

**Dependencies:** None`;

    const result = validateTaskStructure(block);

    expect(result.hasTests).toBe(true);
    expect(result.testCount).toBeGreaterThanOrEqual(2);
  });

  // ─── #1544: hasTests scales by riskTier (verification ladder) ──────────────
  //
  // The universal `hasFiles && hasTests` hard-FAIL flagged every low/medium-tier
  // task lacking tests — the exact over-flag that trained operators to ignore
  // the gate. Under the ladder, low/medium tasks need not carry tests to PASS;
  // only high-tier (or unstamped, conservatively) require them.
  describe('validateTaskStructure — hasTests scales by riskTier (#1544)', () => {
    const filesNoTests = (riskLine: string) => `### Task T-01: Reconcile the planning SoT

${riskLine}

**Description:** Reconcile the planning SoT reference files with the verification ladder so the prose no longer mandates universal test ordering on every task.

**Files:**
- \`content/design/skills/plan/SKILL.md\`
`;

    it('ValidateTaskStructure_LowTierNoTests_StatusPass', () => {
      const result = validateTaskStructure(
        filesNoTests('**riskTier:** low · **boundaryTouching:** false'),
      );
      expect(result.hasTests).toBe(false);
      expect(result.riskTier).toBe('low');
      expect(result.status).toBe('PASS');
    });

    it('ValidateTaskStructure_MediumTierNoTests_StatusPass', () => {
      const result = validateTaskStructure(filesNoTests('**riskTier:** medium'));
      expect(result.hasTests).toBe(false);
      expect(result.status).toBe('PASS');
    });

    it('ValidateTaskStructure_HighTierNoTests_StatusFail', () => {
      const result = validateTaskStructure(
        filesNoTests('**riskTier:** high · **boundaryTouching:** true'),
      );
      expect(result.hasTests).toBe(false);
      expect(result.riskTier).toBe('high');
      expect(result.status).toBe('FAIL');
    });

    it('ValidateTaskStructure_UnstampedNoTests_StatusFail_ConservativeDefault', () => {
      // No riskTier stamp → conservative: tests still required (preserves the
      // pre-ladder strictness for legacy/unstamped plans).
      const result = validateTaskStructure(filesNoTests('**Dependencies:** None'));
      expect(result.hasTests).toBe(false);
      expect(result.riskTier).toBeUndefined();
      expect(result.status).toBe('FAIL');
    });

    it('ValidateTaskStructure_CanonicalTemplateRiskTierStamp_LowTierNoTests_StatusPass', () => {
      // The task template prescribes the title-case, spaced form
      // `**Risk Tier:** low` (task-template.md:10). A plan authored to the
      // template must be read correctly — otherwise a low-tier task wrongly
      // fails for lacking tests, defeating #1544.
      const result = validateTaskStructure(filesNoTests('**Risk Tier:** low'));
      expect(result.riskTier).toBe('low');
      expect(result.hasTests).toBe(false);
      expect(result.status).toBe('PASS');
    });

    it('ValidateTaskStructure_HyphenatedTierSuffix_NotTreatedAsStamp', () => {
      // A malformed stamp like `riskTier: low-priority` must NOT read as `low`
      // (the `\b` boundary used to match before the hyphen). Falls through to the
      // conservative default rather than silently misclassifying.
      const result = validateTaskStructure(filesNoTests('**riskTier:** low-priority cleanup'));
      expect(result.riskTier).toBeUndefined();
      expect(result.status).toBe('FAIL');
    });

    it('ValidateTaskStructure_ProseMentionsTierWords_NotTreatedAsStamp', () => {
      // Prose that mentions "riskTier" alongside a tier word but is NOT a
      // `riskTier: <tier>` stamp must not be read as a stamp — otherwise an
      // unstamped task is silently misclassified. Conservative default applies:
      // no stamp → tests still required → FAIL.
      const result = validateTaskStructure(
        filesNoTests('The riskTier model governs high-blast-radius edits.'),
      );
      expect(result.riskTier).toBeUndefined();
      expect(result.status).toBe('FAIL');
    });

    it('ValidateTaskStructure_HighTierWithTests_StatusPass', () => {
      const block = `### Task T-01: Reshape the schema

**riskTier:** high

**Files:**
- \`src/schema.ts\`

**Tests:**
- [RED] \`Schema_Reshape_Validates\`
`;
      const result = validateTaskStructure(block);
      expect(result.hasTests).toBe(true);
      expect(result.status).toBe('PASS');
    });
  });

  // ─── T-12 description-span contract (DR-5 step 1/3) ──────────────────────
  //
  // The description span is "everything between the task heading and the next
  // field-header (`**...**:`) or section header (`### `)". The first
  // field-header encountered (e.g. `**Goal:**` or `**Description:**`) is
  // *included* as the description introducer; the SECOND field-header (e.g.
  // `**Files:**`, `**Acceptance criteria:**`) terminates the span. This lets
  // plans authored to the standard `@skills/implementation-planning` shape
  // (which uses `**Goal:**`, not `**Description:**`) score correctly.

  it('validateTaskStructure_TaskWithGoalSection_CountsGoalProseAsDescription', () => {
    // Block uses `**Goal:**` (not `**Description:**`) followed by ~50 words of
    // substantive prose. The new contract counts that prose as the
    // description; the legacy `**Description:**`-literal parser reports 0.
    const block = `### Task T-01: Author the schema module

**Goal:** Define the schema module that exposes per-record validation rules
across the ingestion pipeline, declaring both the input row shape and the
projected normalized shape consumed by the downstream alerting layer. The
module must carry a frozen sample-set so future schema drift is caught at
build time rather than at runtime when the dashboard renders empty results.

**Files:**
- \`src/schema/module.ts\`
- \`src/schema/module.test.ts\`

**Tests:**
- [RED] \`Schema_Validate_RejectsMalformedRow\`

**Dependencies:** None
**Parallelizable:** Yes`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
  });

  it('validateTaskStructure_TaskWithMultipleSections_DescriptionStopsAtNextFieldHeader', () => {
    // Block carries `**Goal:**` content followed by `**Acceptance criteria:**`.
    // The description span includes the Goal prose only; words after the
    // Acceptance criteria field-header MUST NOT be folded into the
    // description count.
    const block = `### Task T-02: Wire the gate handler

**Goal:** Wire the freshly authored gate handler into the orchestrate dispatch
table so the workflow surface can invoke it directly without bash detour.

**Acceptance criteria:**
- The gate handler appears in the dispatch table alongside its peers and the
  acceptance suite covers every documented status code with a dedicated
  characterization assertion that exercises the surrounding event emission.

**Files:**
- \`src/verbs/gate-handler.ts\``;

    const result = validateTaskStructure(block);

    // "Wire the freshly authored gate handler into the orchestrate dispatch
    // table so the workflow surface can invoke it directly without bash detour."
    // ~22 words. Acceptance criteria adds ~30 words; if those leak in the
    // count would jump well past 30.
    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    expect(result.descriptionWordCount).toBeLessThan(30);
  });

  // F20 (#1213): only `**Goal:**` / `**Description:**` headers introduce
  // the description span. Tasks that open with `**Files:**` /
  // `**Dependencies:**` / `**Tests:**` etc. used to mis-count the inline
  // tail of those headers as description prose, which silently satisfied
  // the 10-word threshold and masked legitimate missing-description
  // failures.
  it('ExtractDescription_TaskBeginsWithFilesHeader_DoesNotCountFilesAsDescription', () => {
    // The first field header after the title is `**Files:**`, with multiple
    // backtick-quoted paths inline. The whole block carries NO narrative
    // prose: no naked sentence, no `**Goal:**`, no `**Description:**`.
    // The validator must therefore report a missing description.
    const block = `### Task T-99: terse files-only task

**Files:** \`src/foo.ts\`, \`src/bar.ts\`, \`src/baz.ts\`, \`src/quux.ts\`, \`src/zap.ts\`, \`src/widget.ts\`

**Tests:**
- [RED] \`Foo_Bar_Baz\`

**Dependencies:** None
**Parallelizable:** No`;

    const result = validateTaskStructure(block);

    // The 6 paths inline on the **Files:** header would, under the old
    // first-field-wins rule, contribute several words and could push past
    // the 10-word threshold. With the F20 fix that header terminates the
    // description scan instead of introducing it, so the count is zero
    // and `hasDescription` is false.
    expect(result.hasDescription).toBe(false);
    expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
  });

  it('ExtractDescription_TaskBeginsWithDependenciesHeader_DoesNotCountDepsAsDescription', () => {
    // Same shape, different leading non-description header. Same rule.
    const block = `### Task T-77: deps-first task

**Dependencies:** T001, T002, T003, T004, T005, T006, T007, T008, T009, T010, T011

**Files:**
- \`src/foo.ts\`

**Tests:**
- [RED] \`Foo_Bar_Baz\`

**Parallelizable:** No`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(false);
    expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
  });

  it('validateTaskStructure_NoFieldHeaders_FullBodyCounted', () => {
    // Block has naked prose under the task heading with no field-headers at
    // all. The new contract counts the entire body as the description.
    const block = `### Task T-03: Naked prose task

This task has no field headers whatsoever. The author wrote a brief paragraph
of substantive narrative prose describing the work to be done, and trusted
that the structural validator would still recognize the description as
present without requiring a literal Description field-header marker.`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(20);
  });

  // ─── T-02 (#1486): task-template.md parity ──────────────────────────────
  //
  // A task authored VERBATIM from
  // `content/design/skills/plan/references/task-template.md` puts the
  // brief description IN the `### Task [N]: [Brief Description]` heading and
  // immediately follows it with `**Phase:**` — there is NO `**Goal:**` or
  // `**Description:**` introducer. Under the pre-T-02 contract the heading
  // line was skipped and `**Phase:**` (a non-introducer field header)
  // terminated the scan, yielding `Description: 0 words` / needsRework. The
  // gate must instead credit the heading's brief-description tail (plus any
  // naked TDD-step prose) so the canonical template shape is well-decomposed.
  it('ValidateTaskStructure_TemplateShapedTask_HasDescription', () => {
    // Verbatim template shape: brief description in the heading, body opens
    // with **Phase:** and carries **Test Layer:** / **Implements:** /
    // **TDD Steps:** / **Verification:** / **Dependencies:** / **Parallelizable:**.
    const block = `### Task T-04: Implement the per-record validation schema module that the ingestion pipeline uses to reject malformed rows

**Phase:** RED
**Test Layer:** unit
**Implements:** DR-5

**TDD Steps:**
1. [RED] Write test: \`Schema_Validate_RejectsMalformedRow\`
   - File: \`src/schema/module.test.ts\`
   - Expected failure: validator does not yet exist so the import throws
   - Run: \`npm run test:run\` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: \`src/schema/module.ts\`
   - Changes: add the validate function returning normalized rows
   - Run: \`npm run test:run\` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes`;

    const result = validateTaskStructure(block);

    // Brief-description heading tail counts toward the description signal so
    // the canonical template shape is credited (not flagged needsRework).
    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    // The task is well-formed end-to-end: description + files + tests.
    expect(result.hasFiles).toBe(true);
    expect(result.hasTests).toBe(true);
    expect(result.status).toBe('PASS');
  });

  // ─── T-02 (#1486): F20 / #1213 guard MUST NOT regress ───────────────────
  //
  // Over-broadening the description signal could re-introduce the #1213 bug
  // where an inline `**Files:** \`a.ts\`, \`b.ts\`` list satisfied the
  // 10-word threshold. A task whose ONLY "prose" is a backtick-quoted file
  // list (no heading brief, no naked narrative) must STILL be flagged
  // missing-description.
  it('ValidateTaskStructure_FilesListOnly_NotCountedAsDescription', () => {
    // Heading carries no brief description; the only content is an inline
    // **Files:** list of backtick-quoted paths.
    const block = `### Task T-05:

**Files:** \`src/a.ts\`, \`src/b.ts\`, \`src/c.ts\`, \`src/d.ts\`, \`src/e.ts\`, \`src/f.ts\`, \`src/g.ts\`

**Tests:**
- [RED] \`Foo_Bar_Baz\`

**Dependencies:** None
**Parallelizable:** No`;

    const result = validateTaskStructure(block);

    // Backtick-quoted file paths are NOT description prose (F20 / #1213).
    expect(result.hasDescription).toBe(false);
    expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
  });
});

describe('validateDependencyDAG', () => {
  it('ValidateDependencyDAG_NoCycles_ReturnsValid', () => {
    const tasks = [
      { id: 'T-01', deps: [] },
      { id: 'T-02', deps: ['T-01'] },
      { id: 'T-03', deps: ['T-01'] },
    ];

    const result = validateDependencyDAG(tasks);

    expect(result.valid).toBe(true);
    expect(result.cyclePath).toBeUndefined();
  });

  it('ValidateDependencyDAG_CycleDetected_ReportsPath', () => {
    const tasks = [
      { id: 'T-01', deps: ['T-02'] },
      { id: 'T-02', deps: ['T-01'] },
    ];

    const result = validateDependencyDAG(tasks);

    expect(result.valid).toBe(false);
    expect(result.cyclePath).toBeDefined();
    // The cycle path should mention both T-01 and T-02
    expect(result.cyclePath).toContain('T-01');
    expect(result.cyclePath).toContain('T-02');
  });
});

// ─── T-13 dependency-parser contract (DR-5 step 2/3) ────────────────────
//
// `extractDependencies` MUST anchor strictly to the `**Dependencies:**` line
// and MUST match both `T-XX` and `TXX` formats via a single regex
// `\b(T-?\d+)\b`. There is NO greedy `[0-9]+` fallback — if the deps line
// contains no `T<id>`/`T-<id>` token, the helper returns `[]`.
//
// Normalization decision (documented for posterity): the helper returns
// matches **verbatim** — `T-001` stays `T-001`, `T002` stays `T002`. The
// equivalence between `T-NNN`, `TNNN`, and `NNN` is handled at comparison
// time inside `validateDependencyDAG` (canonical form: strip leading
// `T-?` and leading zeros). Doing it here would conflate task-ID forms
// emitted by `parseTaskBlocks`, which preserves the form as written.

describe('extractDependencies', () => {
  it('extractDependencies_ThyphenIdFormat_ReturnsTIds', () => {
    const block = `### Task T-XX: example

**Description:** sample task body that should be ignored by the dependency
parser entirely. Numbers like 24 in prose must not leak.

**Dependencies:** T-001, T-002
**Parallelizable:** No`;

    expect(extractDependencies(block)).toEqual(['T-001', 'T-002']);
  });

  it('extractDependencies_NoHyphenIdFormat_ReturnsTIds', () => {
    const block = `### Task TXX: example

**Description:** sample task body.

**Dependencies:** T001, T002
**Parallelizable:** No`;

    // Verbatim — see header comment for normalization decision.
    expect(extractDependencies(block)).toEqual(['T001', 'T002']);
  });

  it('extractDependencies_NarrativeContainsRollup24h_DoesNotExtract24', () => {
    // Regression for the agency-csl-auto-pr fixture (T-13). Task 033's deps
    // line embeds prose that contains `Rollup24h`. The greedy `[0-9]+`
    // fallback used to scrape `24` out of `Rollup24h` and treat it as an
    // unknown dependency. The new parser must return only the T-id.
    const block = `### Task 033: SLO sample-size dashboard panel

**Description:** add a Grafana panel.

**Dependencies:** T002 (\`GetCslSloRollup24h\` exposes sample size per SLO)
**Parallelizable:** No`;

    const deps = extractDependencies(block);
    expect(deps).toEqual(['T002']);
    expect(deps).not.toContain('24');
  });

  it('extractDependencies_NoTIdsAtAll_ReturnsEmptyArray', () => {
    const block = `### Task T-01: example

**Description:** sample.

**Dependencies:** none
**Parallelizable:** No`;

    expect(extractDependencies(block)).toEqual([]);
  });

  it('extractDependencies_DigitsInOtherLines_NotExtracted', () => {
    // Deps line is empty — must not fall back to digit-scraping the wider
    // block (which contains `2024` in prose, file paths with version-like
    // numbers, etc.).
    const block = `### Task T-01: build the 2024 rollup pipeline

**Description:** Process 1000 records per second from the 24-hour buffer.

**Files:**
- \`src/v1/api-2024.ts\`

**Dependencies:**
**Parallelizable:** No`;

    expect(extractDependencies(block)).toEqual([]);
  });
});

// ─── T-14 file-conflict extension-filter contract (DR-5 step 3/3) ────────
//
// `extractFiles` MUST require a known file extension before treating a
// backtick-quoted token as a file path. Tokens like `imageProvenance.isFirstParty`
// (TypeScript record-field references in narrative prose) MUST NOT match.
// This closes the final fixture-level `parallelSafe === true` assertion in
// `task-decomposition.fixtures.test.ts`.
//
// Allowed extensions:
//   ts | tsx | js | jsx | mjs | cjs | json | md | yml | yaml | sh | ps1
//   sql | kql | bicep | cs | csproj | sln | go | rs | toml
//
// The same extension allowlist must apply to both `extractFiles` and the
// inline file-path pattern inside `validateTaskStructure`. After T-14
// REFACTOR they share a module-level `FILE_EXTENSION_ALLOWLIST` constant.

describe('extractFiles', () => {
  it('extractFiles_DottedIdentifierLikeFieldName_NotMatched', () => {
    // Regression for the agency-csl-auto-pr fixture. TypeScript record-field
    // references in narrative prose used to be scraped as file paths because
    // the prior regex required only `.<alphabetic>` after a backtick token.
    // The tightened regex limits matches to a known-extension allowlist.
    const block = `### Task T-01: example

**Goal:** When the upstream signal flips, propagate \`imageProvenance.isFirstParty\`
through the projection so downstream consumers see the change without polling.

**Files:**
- \`src/projection/provenance.ts\`

**Dependencies:** None
**Parallelizable:** Yes`;

    const files = extractFiles(block);
    expect(files).not.toContain('imageProvenance.isFirstParty');
  });

  it('extractFiles_FourHashSubHeaderTerminatesScan_NoLeak', () => {
    // Regression (#1670 shepherd / Sentry): the Files scan must terminate at the
    // next section header at EITHER depth. On the majority-`####` corpus a
    // `#### <Sub>` header after **Files:** must END the section — before the fix
    // `/^###\s/` didn't match `####`, so a backtick path in a later sub-section
    // was swept into the file list (same 3-hash-only bug DR-5 fixed for
    // parseTaskBlocks; extractFiles was the sibling it missed).
    const block = `#### Task 05: example

**Files:**
- \`src/real.ts\`

#### Acceptance criteria
- The change must not scrape \`src/leaked.ts\` from this sub-section.`;

    const files = extractFiles(block);
    expect(files).toContain('src/real.ts');
    expect(files).not.toContain('src/leaked.ts');
  });

  it('extractFiles_KnownExtension_Matched', () => {
    // Sanity: the allowlist MUST cover the canonical project extensions
    // used in real plans (TypeScript source, JSON config, Markdown docs).
    const block = `### Task T-01: example

**Goal:** Author the module, the config, and the readme entry.

**Files:**
- \`src/foo.ts\`
- \`config.json\`
- \`README.md\`

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).toContain('src/foo.ts');
    expect(files).toContain('config.json');
    expect(files).toContain('README.md');
  });

  it('extractFiles_UnknownExtension_NotMatched', () => {
    // The allowlist is closed. A backtick-quoted token whose suffix is not
    // on the list (e.g. `.unknownext`) MUST NOT match, even if its shape
    // otherwise resembles a path.
    const block = `### Task T-01: example

**Goal:** Reference an unknown-suffix token.

The token \`some.unknownext\` appears in prose but is not a real file path
the validator should treat as a target.

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).not.toContain('some.unknownext');
  });

  // ─── #1213 / CodeRabbit #17: inline **Files:** header parsing ─────────
  it('extractFiles_InlineFilesHeader_CapturesPathOnSameLine', () => {
    // Regression: when the **Files:** header carries paths inline on the
    // same line (instead of a multi-line list), the parser dropped them
    // because it `continue`-d past the header without inspecting the tail.
    // Now the inline tail is captured before falling through to the next
    // line.
    const block = `### Task T-01: example

**Goal:** Inline files header.

**Files:** \`src/inline-only.ts\`

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).toContain('src/inline-only.ts');
  });

  it('extractFiles_InlineFilesHeader_MultiplePaths_AllCaptured', () => {
    // Multiple comma-separated inline paths on the **Files:** header line.
    const block = `### Task T-02: example

**Goal:** Multiple inline paths.

**Files:** \`src/a.ts\`, \`src/b.ts\`, \`config.json\`

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.ts');
    expect(files).toContain('config.json');
  });

  // ─── F21 (#1213): explicit Files section is authoritative even if empty
  it('ExtractFiles_ExplicitFilesNone_ReturnsEmptyAndSkipsFallback', () => {
    // The author declared the Files section explicitly and put `none`
    // there (no allowlisted paths). Other parts of the task body
    // contain unrelated backtick-quoted paths (e.g. a snippet showing
    // a *prior* file the task replaces, or an example reference). The
    // explicit Files section is authoritative — fallback inference
    // MUST NOT scrape those unrelated backticks and pollute the file
    // count, which would produce false parallel-conflict reports.
    const block = `### Task T-99: pure prose / docs task

**Goal:** Update the narrative description in the README so it reflects
the renamed module \`unrelated.ts\` mentioned in the prior commit. Also
clarify the snippet about \`example.json\` from earlier docs.

**Files:** none

**Tests:**
- [RED] \`Doc_Update_NoFiles\`

**Dependencies:** None
**Parallelizable:** Yes`;

    const files = extractFiles(block);
    // The unrelated `unrelated.ts` and `example.json` backticks elsewhere
    // in the task body MUST NOT be returned. The explicit Files section
    // declared zero paths, and that's the answer.
    expect(files).not.toContain('unrelated.ts');
    expect(files).not.toContain('example.json');
    expect(files).toEqual([]);
  });

  it('ExtractFiles_NoFilesSection_FallsBackToWholeBlockInference', () => {
    // No explicit **Files:** header anywhere in the block — preserve
    // existing behavior of scraping the whole block for backtick paths
    // with allowlisted extensions. (Regression-guard for the legacy
    // shape; without this assertion the F21 fix would silently break
    // tasks that omit the Files header entirely.)
    const block = `### Task T-50: legacy shape, no Files header

**Goal:** Edit \`src/legacy.ts\` and \`src/legacy.test.ts\` to reflect
the new contract.

**Tests:**
- [RED] \`Legacy_Contract_Honored\`

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).toContain('src/legacy.ts');
    expect(files).toContain('src/legacy.test.ts');
  });

  it('checkParallelSafety_AgencyCslLikeNarrative_NoFalseConflicts', () => {
    // End-to-end regression on the agency-csl shape: two parallel tasks
    // that share dotted-identifier *field-name* references in prose but
    // have disjoint *file* targets must NOT be flagged as conflicting.
    const blockA = `### Task T-001: producer side

**Goal:** Emit the \`imageProvenance.isFirstParty\` signal and the
\`mutatingTool.detected\` flag from the upstream extractor.

**Files:**
- \`src/extractor/producer.ts\`
- \`src/extractor/producer.test.ts\`

**Dependencies:** None
**Parallelizable:** Yes`;

    const blockB = `### Task T-002: consumer side

**Goal:** React to \`imageProvenance.isFirstParty\` and \`mutatingTool.detected\`
on the projection side without coupling to the producer module.

**Files:**
- \`src/projection/consumer.ts\`
- \`src/projection/consumer.test.ts\`

**Dependencies:** None
**Parallelizable:** Yes`;

    const tasks = [
      { id: 'T-001', isParallel: true, files: extractFiles(blockA) },
      { id: 'T-002', isParallel: true, files: extractFiles(blockB) },
    ];

    const result = checkParallelSafety(tasks);
    expect(result.safe).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('checkParallelSafety', () => {
  it('CheckParallelSafety_NoConflicts_Passes', () => {
    const tasks = [
      {
        id: 'T-01',
        isParallel: true,
        files: ['src/components/widget.ts', 'src/components/widget.test.ts'],
      },
      {
        id: 'T-02',
        isParallel: true,
        files: ['src/api/client.ts', 'src/api/client.test.ts'],
      },
    ];

    const result = checkParallelSafety(tasks);

    expect(result.safe).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('CheckParallelSafety_FileOverlap_ReportsConflict', () => {
    const tasks = [
      {
        id: 'T-01',
        isParallel: true,
        files: ['src/contract/shared/utils.ts', 'src/contract/shared/utils.test.ts'],
      },
      {
        id: 'T-02',
        isParallel: true,
        files: ['src/contract/shared/utils.ts', 'src/contract/shared/format.test.ts'],
      },
    ];

    const result = checkParallelSafety(tasks);

    expect(result.safe).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    // Should mention the conflicting file
    expect(result.conflicts[0]).toContain('src/contract/shared/utils.ts');
    // Should mention both task IDs
    expect(result.conflicts[0]).toContain('T-01');
    expect(result.conflicts[0]).toContain('T-02');
  });
});

describe('handleTaskDecomposition', () => {
  const stateDir = '/tmp/test-state';
  const baseArgs = {
    featureId: 'test-feature',
    planPath: 'docs/plans/test.md',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('HandleTaskDecomposition_MissingFeatureId_ReturnsError', async () => {
    const args = { featureId: '', planPath: 'docs/plans/test.md' };

    const result = await handleTaskDecomposition(args, stateDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('HandleTaskDecomposition_MissingPlanPath_ReturnsError', async () => {
    const args = { featureId: 'test-feature', planPath: '' };

    const result = await handleTaskDecomposition(args, stateDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('HandleTaskDecomposition_FullIntegration_ReturnsStructuredResult', async () => {
    // Arrange: mock readFile to return a valid plan
    mockedReadFile.mockResolvedValue(WELL_DECOMPOSED_PLAN);

    // Act
    const result = await handleTaskDecomposition(baseArgs, stateDir, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      wellDecomposed: number;
      needsRework: number;
      totalTasks: number;
      dagValid: boolean;
      parallelSafe: boolean;
    };
    expect(data.passed).toBe(true);
    expect(data.totalTasks).toBe(3);
    expect(data.wellDecomposed).toBe(3);
    expect(data.needsRework).toBe(0);
    expect(data.dagValid).toBe(true);
    expect(data.parallelSafe).toBe(true);

    // Should emit gate event
    expect(mockedEmitGateEvent).toHaveBeenCalledOnce();
    expect(mockedEmitGateEvent).toHaveBeenCalledWith(
      mockStore,
      'test-feature',
      'task-decomposition',
      'planning',
      true,
      expect.objectContaining({
        dimension: 'D5',
        phase: 'plan',
        wellDecomposed: 3,
        needsRework: 0,
        totalTasks: 3,
      }),
    );
  });
});

// ─── P02-06: decomposition & risk plausibility (handler integration) ────────
//
// The structural gate historically accepted whatever risk/boundary stamps a
// planner declared. These tests prove the handler now surfaces a STRUCTURED
// CHALLENGE (typed `plausibility` findings + a report section) for implausible
// decompositions, without flipping `passed` (it is a challenge, not a hard
// fail) and without silently accepting them.

interface PlausibilityChallengeShape {
  readonly signal: string;
  readonly scope: string;
  readonly taskId?: string;
  readonly observed: number;
  readonly threshold: number;
  readonly message: string;
}
interface PlausibilityShape {
  readonly challenged: boolean;
  readonly challenges: readonly PlausibilityChallengeShape[];
  readonly overridden: readonly (PlausibilityChallengeShape & { overrideRationale: string })[];
}
interface DecompositionDataShape {
  readonly passed: boolean;
  readonly plausibility: PlausibilityShape;
  readonly report: string;
}

function uniformLowNoBoundaryPlan(n: number): string {
  const tasks = Array.from({ length: n }, (_, i) => {
    const id = `T-${String(i + 1).padStart(2, '0')}`;
    return [
      `### Task ${id}: Deliver bounded increment ${i + 1} with clearly scoped intent`,
      '',
      '**Risk Tier:** low · **Boundary Touching:** false',
      '',
      '**Files:**',
      `- \`src/mod${i}/file.ts\``,
      '',
      '**Dependencies:** None',
      '**Parallelizable:** No',
    ].join('\n');
  });
  return `# Implementation Plan\n\n## Tasks\n\n${tasks.join('\n\n')}\n`;
}

describe('handleTaskDecomposition — plausibility (P02-06)', () => {
  const stateDir = '/tmp/test-state';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('HandleTaskDecomposition_48TasksUniformLowNoBoundary_ChallengesButPasses', async () => {
    // Exit-proof (a): a 48-task plan uniformly stamped low-risk / no-boundary
    // triggers a structured challenge on both uniformity signals — surfaced,
    // not silently accepted — while remaining a PASS (challenge, not hard fail).
    mockedReadFile.mockResolvedValue(uniformLowNoBoundaryPlan(48));

    const result = await handleTaskDecomposition(
      { featureId: 'f', planPath: 'p.md' },
      stateDir,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionDataShape;
    expect(data.plausibility.challenged).toBe(true);
    const signals = data.plausibility.challenges.map((c) => c.signal).sort();
    expect(signals).toContain('risk-uniformity');
    expect(signals).toContain('boundary-uniformity');
    // Structured challenge, NOT a hard fail: structure is otherwise sound.
    expect(data.passed).toBe(true);
    // Not silent — the report calls it out.
    expect(data.report).toContain('CHALLENGE (risk-uniformity)');
  });

  it('HandleTaskDecomposition_OversizedTask_ChallengesHistoricalSize', async () => {
    // Exit-proof (b): a single task whose file set dwarfs a historical task
    // triggers a historical-size challenge.
    const files = Array.from({ length: 15 }, (_, i) => `- \`src/mod/file${i}.ts\``).join('\n');
    const plan = [
      '# Implementation Plan',
      '',
      '## Tasks',
      '',
      '### Task T-01: One oversized task that swallows fifteen files in a single unit',
      '',
      '**Risk Tier:** high · **Boundary Touching:** true',
      '',
      '**Files:**',
      files,
      '',
      '**Tests:**',
      '- [RED] `Giant_Does_Everything`',
      '',
      '**Dependencies:** None',
    ].join('\n');
    mockedReadFile.mockResolvedValue(plan);

    const result = await handleTaskDecomposition(
      { featureId: 'f', planPath: 'p.md' },
      stateDir,
      mockStore as unknown as EventStore,
    );

    const data = result.data as DecompositionDataShape;
    expect(data.plausibility.challenged).toBe(true);
    const size = data.plausibility.challenges.find((c) => c.signal === 'historical-size');
    expect(size).toBeDefined();
    expect(size?.taskId).toBe('T-01');
    expect(size?.observed).toBe(15);
  });

  it('HandleTaskDecomposition_WellDecomposedPlan_NoPlausibilityChallenge', async () => {
    // Exit-proof (c): the canonical well-decomposed fixture (3 mixed tasks,
    // small file sets) produces no plausibility challenge.
    mockedReadFile.mockResolvedValue(WELL_DECOMPOSED_PLAN);

    const result = await handleTaskDecomposition(
      { featureId: 'f', planPath: 'p.md' },
      stateDir,
      mockStore as unknown as EventStore,
    );

    const data = result.data as DecompositionDataShape;
    expect(data.plausibility.challenged).toBe(false);
    expect(data.plausibility.challenges).toHaveLength(0);
    expect(data.report).toContain('No plausibility challenges');
  });

  it('HandleTaskDecomposition_BreadthOverrideWithRationale_SuppressesChallenge', async () => {
    // Exit-proof (d): an explicit `**Plausibility Override:**` line with a
    // non-empty rationale suppresses the breadth challenge; the override is
    // recorded (auditable), not invisible.
    const plan = [
      '# Implementation Plan',
      '',
      '## Tasks',
      '',
      '### Task T-01: Cross-cutting rename that legitimately spans many modules by design',
      '',
      '**Risk Tier:** medium · **Boundary Touching:** true',
      '',
      '**Files:**',
      '- `a/1.ts`',
      '- `b/2.ts`',
      '- `c/3.ts`',
      '- `d/4.ts`',
      '- `e/5.ts`',
      '',
      '**Plausibility Override:** breadth: atomic cross-module rename, cannot be split',
      '',
      '**Tests:**',
      '- [RED] `Rename_AllModules_Consistent`',
      '',
      '**Dependencies:** None',
    ].join('\n');
    mockedReadFile.mockResolvedValue(plan);

    const result = await handleTaskDecomposition(
      { featureId: 'f', planPath: 'p.md' },
      stateDir,
      mockStore as unknown as EventStore,
    );

    const data = result.data as DecompositionDataShape;
    expect(data.plausibility.challenges.some((c) => c.signal === 'breadth')).toBe(false);
    const overridden = data.plausibility.overridden.find((c) => c.signal === 'breadth');
    expect(overridden).toBeDefined();
    expect(overridden?.overrideRationale).toBe('atomic cross-module rename, cannot be split');
    expect(data.report).toContain('OVERRIDDEN (breadth)');
  });

  it('HandleTaskDecomposition_BreadthOverrideMissing_DoesNotSuppress', async () => {
    // Companion to (d): the SAME broad task WITHOUT the override line is
    // challenged — proving the suppression is driven by the rationale, not the
    // task shape.
    const plan = [
      '# Implementation Plan',
      '',
      '## Tasks',
      '',
      '### Task T-01: Cross-cutting rename that legitimately spans many modules by design',
      '',
      '**Risk Tier:** medium · **Boundary Touching:** true',
      '',
      '**Files:**',
      '- `a/1.ts`',
      '- `b/2.ts`',
      '- `c/3.ts`',
      '- `d/4.ts`',
      '- `e/5.ts`',
      '',
      '**Tests:**',
      '- [RED] `Rename_AllModules_Consistent`',
      '',
      '**Dependencies:** None',
    ].join('\n');
    mockedReadFile.mockResolvedValue(plan);

    const result = await handleTaskDecomposition(
      { featureId: 'f', planPath: 'p.md' },
      stateDir,
      mockStore as unknown as EventStore,
    );

    const data = result.data as DecompositionDataShape;
    expect(data.plausibility.challenges.some((c) => c.signal === 'breadth')).toBe(true);
    expect(data.plausibility.overridden).toHaveLength(0);
  });
});
