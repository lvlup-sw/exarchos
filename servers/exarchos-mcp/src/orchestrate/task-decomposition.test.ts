import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({
    append: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
}));

// We mock fs for handleTaskDecomposition integration test
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';
import {
  parseTaskBlocks,
  validateTaskStructure,
  validateDependencyDAG,
  checkParallelSafety,
  handleTaskDecomposition,
} from './task-decomposition.js';

const mockedEmitGateEvent = vi.mocked(emitGateEvent);
const mockedGetOrCreateEventStore = vi.mocked(getOrCreateEventStore);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

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
    mockedGetOrCreateEventStore.mockReturnValue({
      append: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getOrCreateEventStore>);
  });

  it('HandleTaskDecomposition_MissingFeatureId_ReturnsError', async () => {
    const args = { featureId: '', planPath: 'docs/plans/test.md' };

    const result = await handleTaskDecomposition(args, stateDir);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('HandleTaskDecomposition_MissingPlanPath_ReturnsError', async () => {
    const args = { featureId: 'test-feature', planPath: '' };

    const result = await handleTaskDecomposition(args, stateDir);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('HandleTaskDecomposition_FullIntegration_ReturnsStructuredResult', async () => {
    // Arrange: mock fs.readFileSync to return a valid plan
    mockedReadFileSync.mockReturnValue(WELL_DECOMPOSED_PLAN);

    // Act
    const result = await handleTaskDecomposition(baseArgs, stateDir);

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
      expect.anything(),
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
