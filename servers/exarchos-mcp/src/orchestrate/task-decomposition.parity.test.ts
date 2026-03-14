import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({
    appendEvent: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import {
  parseTaskBlocks,
  validateTaskStructure,
  validateDependencyDAG,
  checkParallelSafety,
  handleTaskDecomposition,
} from './task-decomposition.js';

/**
 * Behavioral parity tests for task-decomposition.ts against the original
 * scripts/check-task-decomposition.sh bash script.
 *
 * Bash script behavior (check-task-decomposition.sh):
 *   - Well-decomposed (exit 0): 3 tasks all PASS
 *       descriptions 20-22 words, files and tests present, valid DAG, no parallel conflicts
 *   - Missing description (exit 1): 1 task FAIL
 *       2 words description, below minimum threshold
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WELL_DECOMPOSED_PLAN = `# Implementation Plan
## Tasks
### Task T-01: Create the widget component with full rendering support
**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.
**Files:**
- \`src/components/widget.ts\`
- \`src/components/widget.test.ts\`
**Tests:**
- [RED] \`Widget_Render_DisplaysContent\` — verify widget renders content
- [RED] \`Widget_EmptyData_ShowsPlaceholder\` — verify empty state
**Dependencies:** None
**Parallelizable:** No
### Task T-02: Create the API client module for backend communication
**Description:** Implement the HTTP client wrapper that handles authentication headers, retry logic, and response parsing for all backend API calls in the application.
**Files:**
- \`src/api/client.ts\`
- \`src/api/client.test.ts\`
**Tests:**
- [RED] \`ApiClient_Fetch_ReturnsData\` — verify data fetching
- [RED] \`ApiClient_Error_ThrowsHttpError\` — verify error handling
- [RED] \`ApiClient_Retry_AttemptsThreeTimes\` — verify retry logic
**Dependencies:** None
**Parallelizable:** Yes
### Task T-03: Create the state manager for application state
**Description:** Build the centralized state management module that handles all application state transitions, subscriptions, and persistence using an event-sourced architecture pattern.
**Files:**
- \`src/state/manager.ts\`
- \`src/state/manager.test.ts\`
**Tests:**
- [RED] \`StateManager_Set_UpdatesState\` — verify state update
- [RED] \`StateManager_Subscribe_NotifiesListeners\` — verify subscriptions
**Dependencies:** T-01, T-02
**Parallelizable:** No`;

const MISSING_DESCRIPTION_PLAN = `# Implementation Plan
## Tasks
### Task T-01: Widget component
**Description:** Build it.
**Files:**
- \`src/components/widget.ts\`
**Tests:**
- [RED] \`Widget_Render_DisplaysContent\`
**Dependencies:** None
**Parallelizable:** No`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('behavioral parity with check-task-decomposition.sh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseTaskBlocks', () => {
    it('well-decomposed plan — parses 3 task blocks with correct IDs', () => {
      const blocks = parseTaskBlocks(WELL_DECOMPOSED_PLAN);

      expect(blocks).toHaveLength(3);
      expect(blocks[0].id).toBe('T-01');
      expect(blocks[1].id).toBe('T-02');
      expect(blocks[2].id).toBe('T-03');
    });

    it('each block contains its full content', () => {
      const blocks = parseTaskBlocks(WELL_DECOMPOSED_PLAN);

      expect(blocks[0].content).toContain('widget rendering component');
      expect(blocks[1].content).toContain('HTTP client wrapper');
      expect(blocks[2].content).toContain('centralized state management');
    });

    it('missing description plan — parses 1 task block', () => {
      const blocks = parseTaskBlocks(MISSING_DESCRIPTION_PLAN);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].id).toBe('T-01');
    });

    it('plan with no tasks — returns empty array', () => {
      const blocks = parseTaskBlocks('# Just a heading\nSome text.\n');

      expect(blocks).toEqual([]);
    });
  });

  describe('validateTaskStructure', () => {
    it('well-decomposed task — PASS with description >10 words, files, and tests (bash: PASS)', () => {
      const blocks = parseTaskBlocks(WELL_DECOMPOSED_PLAN);

      for (const block of blocks) {
        const result = validateTaskStructure(block.content);

        expect(result.status).toBe('PASS');
        expect(result.hasDescription).toBe(true);
        expect(result.descriptionWordCount).toBeGreaterThan(10);
        expect(result.hasFiles).toBe(true);
        expect(result.fileCount).toBeGreaterThanOrEqual(2);
        expect(result.hasTests).toBe(true);
        expect(result.testCount).toBeGreaterThanOrEqual(2);
      }
    });

    it('missing description task — FAIL with <=10 words (bash: exit 1, 2 words)', () => {
      const blocks = parseTaskBlocks(MISSING_DESCRIPTION_PLAN);
      const result = validateTaskStructure(blocks[0].content);

      expect(result.status).toBe('FAIL');
      expect(result.hasDescription).toBe(false);
      expect(result.descriptionWordCount).toBeLessThanOrEqual(10);
    });
  });

  describe('validateDependencyDAG', () => {
    it('well-decomposed plan — valid DAG with no cycles (bash: valid DAG)', () => {
      const dagTasks = [
        { id: 'T-01', deps: [] as string[] },
        { id: 'T-02', deps: [] as string[] },
        { id: 'T-03', deps: ['T-01', 'T-02'] },
      ];

      const result = validateDependencyDAG(dagTasks);

      expect(result.valid).toBe(true);
    });

    it('circular dependency — invalid DAG', () => {
      const dagTasks = [
        { id: 'T-01', deps: ['T-02'] },
        { id: 'T-02', deps: ['T-01'] },
      ];

      const result = validateDependencyDAG(dagTasks);

      expect(result.valid).toBe(false);
    });
  });

  describe('checkParallelSafety', () => {
    it('well-decomposed plan — no file conflicts (bash: no parallel conflicts)', () => {
      const parallelTasks = [
        { id: 'T-01', isParallel: false, files: ['src/components/widget.ts'] },
        { id: 'T-02', isParallel: true, files: ['src/api/client.ts'] },
        { id: 'T-03', isParallel: false, files: ['src/state/manager.ts'] },
      ];

      const result = checkParallelSafety(parallelTasks);

      expect(result.safe).toBe(true);
      expect(result.conflicts).toEqual([]);
    });

    it('overlapping files in parallel tasks — reports conflicts', () => {
      const parallelTasks = [
        { id: 'T-01', isParallel: true, files: ['src/shared.ts'] },
        { id: 'T-02', isParallel: true, files: ['src/shared.ts'] },
      ];

      const result = checkParallelSafety(parallelTasks);

      expect(result.safe).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toContain('src/shared.ts');
    });
  });

  describe('handleTaskDecomposition (handler integration)', () => {
    it('well-decomposed plan — passes with 3/3 tasks, valid DAG, parallel safe (bash: exit 0)', async () => {
      const mockedReadFile = vi.mocked(readFile);
      mockedReadFile.mockResolvedValue(WELL_DECOMPOSED_PLAN);

      const result = await handleTaskDecomposition(
        { featureId: 'test-feature', planPath: '/tmp/plan.md' },
        '/tmp/state',
      );

      expect(result.success).toBe(true);

      const data = result.data as {
        passed: boolean;
        wellDecomposed: number;
        needsRework: number;
        totalTasks: number;
        dagValid: boolean;
        parallelSafe: boolean;
        report: string;
      };

      expect(data.passed).toBe(true);
      expect(data.wellDecomposed).toBe(3);
      expect(data.needsRework).toBe(0);
      expect(data.totalTasks).toBe(3);
      expect(data.dagValid).toBe(true);
      expect(data.parallelSafe).toBe(true);
      expect(data.report).toContain('**Result: PASS**');
    });

    it('missing description plan — fails with 1 task needing rework (bash: exit 1)', async () => {
      const mockedReadFile = vi.mocked(readFile);
      mockedReadFile.mockResolvedValue(MISSING_DESCRIPTION_PLAN);

      const result = await handleTaskDecomposition(
        { featureId: 'test-feature', planPath: '/tmp/plan.md' },
        '/tmp/state',
      );

      expect(result.success).toBe(true);

      const data = result.data as {
        passed: boolean;
        wellDecomposed: number;
        needsRework: number;
        totalTasks: number;
        report: string;
      };

      expect(data.passed).toBe(false);
      expect(data.wellDecomposed).toBe(0);
      expect(data.needsRework).toBe(1);
      expect(data.totalTasks).toBe(1);
      expect(data.report).toContain('**Result: FAIL**');
    });
  });
});
