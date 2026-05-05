import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./gate-utils.js', () => ({
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
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import {
  parseTaskBlocks,
  validateTaskStructure,
  validateDependencyDAG,
  checkParallelSafety,
  handleTaskDecomposition,
  extractDependencies,
} from './task-decomposition.js';

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
- \`src/orchestrate/gate-handler.ts\``;

    const result = validateTaskStructure(block);

    // "Wire the freshly authored gate handler into the orchestrate dispatch
    // table so the workflow surface can invoke it directly without bash detour."
    // ~22 words. Acceptance criteria adds ~30 words; if those leak in the
    // count would jump well past 30.
    expect(result.hasDescription).toBe(true);
    expect(result.descriptionWordCount).toBeGreaterThan(10);
    expect(result.descriptionWordCount).toBeLessThan(30);
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
        files: ['src/shared/utils.ts', 'src/shared/utils.test.ts'],
      },
      {
        id: 'T-02',
        isParallel: true,
        files: ['src/shared/utils.ts', 'src/shared/format.test.ts'],
      },
    ];

    const result = checkParallelSafety(tasks);

    expect(result.safe).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    // Should mention the conflicting file
    expect(result.conflicts[0]).toContain('src/shared/utils.ts');
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
