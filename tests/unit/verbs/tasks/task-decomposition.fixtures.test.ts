/**
 * Regression tests for three false positives of the `check_task_decomposition` parser.
 * `handleTaskDecomposition` reads a real plan fixture from disk. Its tasks use `**Goal:**`, not `**Description:**`.
 *
 * - The description is the text between the task heading and the next field header or section header.
 * - A digit inside a word on a dependency line is not a dependency.
 * - A dotted record field in backticks is not a file path, so it does not cause a file conflict.
 *
 * The gate-utils mock makes event emission inert, because these cases test the parser, not the append failure path.
 * The gate-runner mock calls the provider directly. `gate-runner.test.ts` tests the runner against a real store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
  requireGateEvent: vi.fn().mockResolvedValue(undefined),
  sameOperationGateKey: vi.fn(() => undefined),
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


import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { EventStore } from '../../../../src/events/store.js';
import { handleTaskDecomposition } from '../../../../src/verbs/tasks/task-decomposition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** The fixture path, resolved from this file so that the test runs from any cwd. */
const FIXTURE_PATH = resolve(__dirname, '../../../../src/verbs/fixtures/plans/agency-csl-auto-pr.md');

const STATE_DIR = '/tmp/test-state-task-decomposition-fixtures';

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
};

interface DecompositionData {
  readonly passed: boolean;
  readonly wellDecomposed: number;
  readonly needsRework: number;
  readonly totalTasks: number;
  readonly dagValid: boolean;
  readonly parallelSafe: boolean;
  readonly report: string;
}

describe('check_task_decomposition / agency-csl-auto-pr fixture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Each fixture task has a `**Goal:**` paragraph. The parser must count its words as the description, or each task fails the structure check. */
  it('taskDecomposition_AgencyCslAutoPr_AllTasksWellDecomposed', async () => {
    const result = await handleTaskDecomposition(
      { featureId: 'fixture-agency-csl', planPath: FIXTURE_PATH },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionData;

    expect(data.totalTasks).toBeGreaterThan(0);
    expect(data.wellDecomposed).toBe(data.totalTasks);
    expect(data.needsRework).toBe(0);
  });

  /**
   * The dependency line of the last fixture task mentions `GetCslSloRollup24h`.
   * The parser must not read `24` as a dependency on an unknown task.
   */
  it('taskDecomposition_AgencyCslAutoPr_NoCycleDetected', async () => {
    const result = await handleTaskDecomposition(
      { featureId: 'fixture-agency-csl', planPath: FIXTURE_PATH },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionData;

    expect(data.dagValid).toBe(true);
    expect(data.report).not.toContain('unknown 24');
    expect(data.report).not.toContain('depends on unknown 24');
  });

  /**
   * Two fixture tasks cite the same dotted record fields in prose, such as `imageProvenance.isFirstParty`.
   * These fields are not file paths, so the report must not show them as a file conflict.
   */
  it('taskDecomposition_AgencyCslAutoPr_NoFalseFileConflicts', async () => {
    const result = await handleTaskDecomposition(
      { featureId: 'fixture-agency-csl', planPath: FIXTURE_PATH },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionData;

    expect(data.parallelSafe).toBe(true);
    expect(data.report).not.toContain('imageProvenance.isFirstParty');
    expect(data.report).not.toContain('mutatingTool.detected');
  });
});
