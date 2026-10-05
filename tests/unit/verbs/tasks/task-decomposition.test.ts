/**
 * Tests for the task-decomposition gate: the parser, the structure and dependency checks, parallel safety, and the handler.
 *
 * The gate-utils mock gives `requireGateEvent` its real contract over the mocked `emitGateEvent`.
 * A thrown append withholds the success carrier. `sameOperationGateKey` returns a fixed key, so a test can see that the append has a key.
 * The gate-runner mock calls the provider directly. `gate-runner.test.ts` tests the runner against a real store.
 * The `node:fs/promises` mock lets each handler test supply the plan text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB_GATE_KEY = 'gate.executed:task-decomposition:stub-operation';

/** `vi.hoisted` lifts the mock function above the hoisted `vi.mock` factories, so a factory can reference it directly. */
const { mockEmitGateEvent } = vi.hoisted(() => ({
  mockEmitGateEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: mockEmitGateEvent,
  requireGateEvent: async (
    store: unknown,
    streamId: string,
    gateName: string,
    layer: string,
    passed: boolean,
    carrier: { data?: unknown },
    details?: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    try {
      await mockEmitGateEvent(store, streamId, gateName, layer, passed, details, idempotencyKey);
      return undefined;
    } catch (err) {
      return {
        success: false,
        data: carrier.data,
        error: {
          code: 'GATE_EVENT_UNRECORDED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
  sameOperationGateKey: vi.fn(() => STUB_GATE_KEY),
}));
vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
}));


/** A stub `EventStore` for handler injection. */
const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
};

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

describe('parseTaskBlocks', () => {
  it('ParseTaskBlocks_StandardFormat_ExtractsBlocks', () => {
    const blocks = parseTaskBlocks(WELL_DECOMPOSED_PLAN);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].id).toBe('T-01');
    expect(blocks[1].id).toBe('T-02');
    expect(blocks[2].id).toBe('T-03');
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

/** The repo root, resolved from this file URL, because `__dirname` is not defined under ESM. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * A real spec with only four-hash task headers. The test that reads it skips when the file is absent.
 * Git ignores `docs/specs/`, so the file exists only after `npm run docs:mount`.
 */
const FOUR_HASH_CORPUS_SPEC = resolve(
  REPO_ROOT,
  'docs/specs/2026-07-03-wlm-reconcile-enforce.md',
);

/**
 * Most real specs use four-hash task headers. The parser accepts three-hash and four-hash headers.
 * The legacy three-hash forms with `T-NN` and numeric ids still parse.
 */
describe('parseTaskBlocks — #1670 majority-4-hash corpus (DR-5)', () => {
  /**
   * A pattern for three-hash headers only finds no header in this spec. The parser must find each four-hash task and read its tier stamp.
   * The expected header count comes from the spec, so an edit to the spec does not break the test.
   */
  it.skipIf(!existsSync(FOUR_HASH_CORPUS_SPEC))('ParseTaskBlocks_FourHashCorpusSpec_ExtractsTiers', () => {
    const specPath = FOUR_HASH_CORPUS_SPEC;
    const content = readFileSync(specPath, 'utf-8');

    const OLD_PATTERN = /^###\s+Task\s+(T-[0-9]+|[0-9]+)/;
    const oldHeaderMatches = content.split('\n').filter((l) => OLD_PATTERN.test(l));
    expect(oldHeaderMatches).toHaveLength(0);

    const fourHashHeaderCount = content
      .split('\n')
      .filter((l) => /^####\s+Task\s/.test(l)).length;
    expect(fourHashHeaderCount).toBeGreaterThanOrEqual(20);

    const blocks = parseTaskBlocks(content);
    expect(blocks.length).toBe(fourHashHeaderCount);

    const tiered = blocks.filter(
      (b) => validateTaskStructure(b.content).riskTier !== undefined,
    );
    expect(tiered.length).toBe(blocks.length);
    expect(tiered.length).toBeGreaterThan(0);
  });

  /** The legacy three-hash form keeps its ids and tiers, for `T-NN` ids and for numeric ids. */
  it('ParseTaskBlocks_ThreeHashLegacyId_StillParses', () => {
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

  /** Each heading depth, 3 or 4, with each id form, `T-NN` or `NN`, gives one block with its id and its tier. */
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

  /**
   * The parser strips the four-hash heading prefix before it counts the heading tail.
   * The tail here has 9 words, under the 10-word threshold, so the task has no description.
   */
  it('ValidateTaskStructure_FourHashHeading_DoesNotCountHeadingPrefixAsDescription', () => {
    const block = [
      '#### Task 007: Author the streaming validator that rejects malformed rows early',
      '**Risk Tier:** medium',
    ].join('\n');

    const result = validateTaskStructure(block);
    expect(result.descriptionWordCount).toBe(9);
    expect(result.hasDescription).toBe(false);
    expect(result.riskTier).toBe('medium');
  });

  /**
   * A four-hash template task keeps its description in the heading, and its body opens with a field that is not an introducer.
   * The stripped heading tail counts as the description, the same as for a three-hash heading.
   */
  it('ValidateTaskStructure_FourHashTemplateShape_CreditsHeadingDescription', () => {
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

  /** A short description does not fail a task that has files and tests. The word count is for information only. */
  it('ValidateTaskStructure_ShortDescriptionWithFilesAndTests_DoesNotFailOnWordCount', () => {
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

  /** A `.py` path counts as a file. */
  it('ValidateTaskStructure_PythonFilePath_CountedAsFile', () => {
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
    expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
  });

  /** The description span continues across blank lines, so both paragraphs count. */
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

  /** Only a `high` tier or a missing tier requires tests. A `low` or `medium` task with files and no tests passes. */
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

    /** A task with no tier stamp still needs tests, so legacy plans keep the strict rule. */
    it('ValidateTaskStructure_UnstampedNoTests_StatusFail_ConservativeDefault', () => {
      const result = validateTaskStructure(filesNoTests('**Dependencies:** None'));
      expect(result.hasTests).toBe(false);
      expect(result.riskTier).toBeUndefined();
      expect(result.status).toBe('FAIL');
    });

    /** The task template writes the stamp as `**Risk Tier:** low`. The parser must read this form, or a low-tier task fails for no tests. */
    it('ValidateTaskStructure_CanonicalTemplateRiskTierStamp_LowTierNoTests_StatusPass', () => {
      const result = validateTaskStructure(filesNoTests('**Risk Tier:** low'));
      expect(result.riskTier).toBe('low');
      expect(result.hasTests).toBe(false);
      expect(result.status).toBe('PASS');
    });

    /** A stamp such as `riskTier: low-priority` is not `low`. It falls through to the strict default. */
    it('ValidateTaskStructure_HyphenatedTierSuffix_NotTreatedAsStamp', () => {
      const result = validateTaskStructure(filesNoTests('**riskTier:** low-priority cleanup'));
      expect(result.riskTier).toBeUndefined();
      expect(result.status).toBe('FAIL');
    });

    /** Prose that names `riskTier` and a tier word is not a stamp. With no stamp, the task needs tests, so it fails. */
    it('ValidateTaskStructure_ProseMentionsTierWords_NotTreatedAsStamp', () => {
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

  /**
   * The description span starts at the task heading. A first `**Goal:**` or `**Description:**` header stays in the span.
   * The next field header or task-depth heading ends the span. Thus `**Goal:**` prose counts as the description.
   */
  it('validateTaskStructure_TaskWithGoalSection_CountsGoalProseAsDescription', () => {
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

  /**
   * The span stops at `**Acceptance criteria:**`. The heading tail and the Goal prose hold fewer than 30 words.
   * The criteria add about 30 more, so a leak puts the count over 30.
   */
  it('validateTaskStructure_TaskWithMultipleSections_DescriptionStopsAtNextFieldHeader', () => {
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

    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    expect(result.descriptionWordCount).toBeLessThan(30);
  });

  /**
   * Only `**Goal:**` and `**Description:**` start the description span. Another first field header ends it.
   * Thus an inline file list cannot pass the 10-word threshold. This block has no prose, so it has no description.
   */
  it('ExtractDescription_TaskBeginsWithFilesHeader_DoesNotCountFilesAsDescription', () => {
    const block = `### Task T-99: terse files-only task

**Files:** \`src/foo.ts\`, \`src/bar.ts\`, \`src/baz.ts\`, \`src/quux.ts\`, \`src/zap.ts\`, \`src/widget.ts\`

**Tests:**
- [RED] \`Foo_Bar_Baz\`

**Dependencies:** None
**Parallelizable:** No`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(false);
    expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
  });

  /** The same rule applies when the task opens with `**Dependencies:**`. */
  it('ExtractDescription_TaskBeginsWithDependenciesHeader_DoesNotCountDepsAsDescription', () => {
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

  /** With no field headers, the whole body counts as the description. */
  it('validateTaskStructure_NoFieldHeaders_FullBodyCounted', () => {
    const block = `### Task T-03: Naked prose task

This task has no field headers whatsoever. The author wrote a brief paragraph
of substantive narrative prose describing the work to be done, and trusted
that the structural validator would still recognize the description as
present without requiring a literal Description field-header marker.`;

    const result = validateTaskStructure(block);

    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(20);
  });

  /**
   * A task copied from `task-template.md` keeps its brief description in the heading and opens its body with `**Phase:**`.
   * The heading tail counts as the description, so the template shape passes.
   */
  it('ValidateTaskStructure_TemplateShapedTask_HasDescription', () => {
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

    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    expect(result.hasFiles).toBe(true);
    expect(result.hasTests).toBe(true);
    expect(result.status).toBe('PASS');
  });

  /** A task with no heading text and only an inline `**Files:**` list of paths still has no description. */
  it('ValidateTaskStructure_FilesListOnly_NotCountedAsDescription', () => {
    const block = `### Task T-05:

**Files:** \`src/a.ts\`, \`src/b.ts\`, \`src/c.ts\`, \`src/d.ts\`, \`src/e.ts\`, \`src/f.ts\`, \`src/g.ts\`

**Tests:**
- [RED] \`Foo_Bar_Baz\`

**Dependencies:** None
**Parallelizable:** No`;

    const result = validateTaskStructure(block);

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
    expect(result.cyclePath).toContain('T-01');
    expect(result.cyclePath).toContain('T-02');
  });
});

/**
 * `extractDependencies` reads only the `**Dependencies:**` line. One regex matches ids with or without the hyphen, and there is no digit fallback.
 * It returns ids as written, because `parseTaskBlocks` keeps each id as written. `validateDependencyDAG` compares the canonical forms.
 */
describe('extractDependencies', () => {
  it('extractDependencies_ThyphenIdFormat_ReturnsTIds', () => {
    const block = `### Task T-XX: example

**Description:** sample task body that should be ignored by the dependency
parser entirely. Numbers like 24 in prose must not leak.

**Dependencies:** T-001, T-002
**Parallelizable:** No`;

    expect(extractDependencies(block)).toEqual(['T-001', 'T-002']);
  });

  /** The ids come back as written, with no hyphen added. */
  it('extractDependencies_NoHyphenIdFormat_ReturnsTIds', () => {
    const block = `### Task TXX: example

**Description:** sample task body.

**Dependencies:** T001, T002
**Parallelizable:** No`;

    expect(extractDependencies(block)).toEqual(['T001', 'T002']);
  });

  /** A dependency line with `GetCslSloRollup24h` in its prose must not give `24` as a dependency. */
  it('extractDependencies_NarrativeContainsRollup24h_DoesNotExtract24', () => {
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

  /** With an empty dependency line, the parser does not scan the other lines of the block for digits. */
  it('extractDependencies_DigitsInOtherLines_NotExtracted', () => {
    const block = `### Task T-01: build the 2024 rollup pipeline

**Description:** Process 1000 records per second from the 24-hour buffer.

**Files:**
- \`src/v1/api-2024.ts\`

**Dependencies:**
**Parallelizable:** No`;

    expect(extractDependencies(block)).toEqual([]);
  });
});

/**
 * `extractFiles` accepts a backtick-quoted token as a file only when its extension is on `FILE_EXTENSION_ALLOWLIST`.
 * A record field in prose, such as `imageProvenance.isFirstParty`, is not a file. `validateTaskStructure` uses the same list.
 */
describe('extractFiles', () => {
  it('extractFiles_DottedIdentifierLikeFieldName_NotMatched', () => {
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

  /** The `**Files:**` section ends at the next heading of either depth. A path in a later four-hash sub-section must not join the file list. */
  it('extractFiles_FourHashSubHeaderTerminatesScan_NoLeak', () => {
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

  /** The allowlist is closed. A token with another suffix does not match, even when it looks like a path. */
  it('extractFiles_UnknownExtension_NotMatched', () => {
    const block = `### Task T-01: example

**Goal:** Reference an unknown-suffix token.

The token \`some.unknownext\` appears in prose but is not a real file path
the validator should treat as a target.

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).not.toContain('some.unknownext');
  });

  /** Paths on the same line as the `**Files:**` header count. */
  it('extractFiles_InlineFilesHeader_CapturesPathOnSameLine', () => {
    const block = `### Task T-01: example

**Goal:** Inline files header.

**Files:** \`src/inline-only.ts\`

**Dependencies:** None
**Parallelizable:** No`;

    const files = extractFiles(block);
    expect(files).toContain('src/inline-only.ts');
  });

  it('extractFiles_InlineFilesHeader_MultiplePaths_AllCaptured', () => {
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

  /**
   * An explicit `**Files:**` section is authoritative, even with no path.
   * The parser must not pick up other backtick paths in the body, or the report shows false parallel conflicts.
   */
  it('ExtractFiles_ExplicitFilesNone_ReturnsEmptyAndSkipsFallback', () => {
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
    expect(files).not.toContain('unrelated.ts');
    expect(files).not.toContain('example.json');
    expect(files).toEqual([]);
  });

  /** With no `**Files:**` header, the parser scans the whole block for allowlisted paths. */
  it('ExtractFiles_NoFilesSection_FallsBackToWholeBlockInference', () => {
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

  /** Two parallel tasks share dotted field names in prose but touch different files, so they do not conflict. */
  it('checkParallelSafety_AgencyCslLikeNarrative_NoFalseConflicts', () => {
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
    expect(result.conflicts[0]).toContain('src/contract/shared/utils.ts');
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

  /**
   * The gate event append carries an idempotency key. Without a key, a retry of one operation appends a second `gate.executed` row.
   * The runner runs the provider again before it sees the evidence, and only the evidence row is deduplicated.
   */
  it('HandleTaskDecomposition_FullIntegration_ReturnsStructuredResult', async () => {
    mockedReadFile.mockResolvedValue(WELL_DECOMPOSED_PLAN);

    const result = await handleTaskDecomposition(baseArgs, stateDir, mockStore as unknown as EventStore);

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
      STUB_GATE_KEY,
    );
  });

  /** The verdict stays on `data`. Only the success carrier is withheld. */
  it('TaskDecomposition_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
    mockedReadFile.mockResolvedValue(WELL_DECOMPOSED_PLAN);
    mockEmitGateEvent.mockRejectedValueOnce(new Error('store unavailable'));

    const result = await handleTaskDecomposition(baseArgs, stateDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
    const data = result.data as { passed: boolean; totalTasks: number };
    expect(data.passed).toBe(true);
    expect(data.totalTasks).toBe(3);
  });
});

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

/**
 * For an implausible decomposition, the handler returns typed `plausibility` challenges and a report section.
 * A challenge does not change `passed`.
 */
describe('handleTaskDecomposition — plausibility (P02-06)', () => {
  const stateDir = '/tmp/test-state';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A 48-task plan stamped low risk with no boundary gets both uniformity challenges and still passes. The report names the challenge. */
  it('HandleTaskDecomposition_48TasksUniformLowNoBoundary_ChallengesButPasses', async () => {
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
    expect(data.passed).toBe(true);
    expect(data.report).toContain('CHALLENGE (risk-uniformity)');
  });

  /** A task with 15 files gets a historical-size challenge. */
  it('HandleTaskDecomposition_OversizedTask_ChallengesHistoricalSize', async () => {
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

  /** The well-decomposed fixture, with three tasks and small file sets, gets no challenge. */
  it('HandleTaskDecomposition_WellDecomposedPlan_NoPlausibilityChallenge', async () => {
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

  /** A `**Plausibility Override:**` line with a rationale suppresses the breadth challenge. The result records the override. */
  it('HandleTaskDecomposition_BreadthOverrideWithRationale_SuppressesChallenge', async () => {
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

  /** The same task without the override line gets the challenge. Thus the rationale drives the suppression, not the task shape. */
  it('HandleTaskDecomposition_BreadthOverrideMissing_DoesNotSuppress', async () => {
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
