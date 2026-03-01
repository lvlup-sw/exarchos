import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({
    append: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
}));

import { execSync } from 'node:child_process';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';
import { handleTaskDecomposition } from './task-decomposition.js';

const mockedExecSync = vi.mocked(execSync);
const mockedEmitGateEvent = vi.mocked(emitGateEvent);
const mockedGetOrCreateEventStore = vi.mocked(getOrCreateEventStore);

// ─── Fixture Data ─────────────────────────────────────────────────────────

const PASSING_OUTPUT = `## Task Decomposition Report

**Plan:** \`docs/plans/test.md\`

### Task Structure

| Task | Description | Files | Tests | Status |
|------|-------------|-------|-------|--------|
| T-01 | ✓ (42 words) | ✓ (2 files) | ✓ (3 tests) | PASS |
| T-02 | ✓ (25 words) | ✓ (1 file) | ✓ (2 tests) | PASS |

### Summary
- Well-decomposed: 2/2 tasks
- Needs rework: 0/2 tasks
- Dependency: valid DAG
- Parallel safety: clean

**Result: PASS**`;

const FAILING_OUTPUT = `## Task Decomposition Report

**Plan:** \`docs/plans/test.md\`

### Task Structure

| Task | Description | Files | Tests | Status |
|------|-------------|-------|-------|--------|
| T-01 | ✓ (42 words) | ✓ (2 files) | ✓ (3 tests) | PASS |
| T-02 | ✗ (5 words) | ✓ (1 file) | ✗ (0 tests) | FAIL |

### Summary
- Well-decomposed: 1/2 tasks
- Needs rework: 1/2 tasks
- Dependency: valid DAG
- Parallel safety: clean

**Result: FAIL** — 1 tasks need rework`;

// ─── Tests ────────────────────────────────────────────────────────────────

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

  // Test 1: Passing script emits D5 gate event
  it('HandleTaskDecomposition_PassingScript_EmitsD5GateEvent', async () => {
    // Arrange
    mockedExecSync.mockReturnValue(Buffer.from(PASSING_OUTPUT));

    // Act
    const result = await handleTaskDecomposition(baseArgs, stateDir);

    // Assert
    expect(result.success).toBe(true);
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
      }),
    );
  });

  // Test 2: Failing script returns passed=false
  it('HandleTaskDecomposition_FailingScript_ReturnsFalse', async () => {
    // Arrange
    const error = new Error('Script failed') as Error & {
      status: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    error.status = 1;
    error.stdout = Buffer.from(FAILING_OUTPUT);
    error.stderr = Buffer.from('');
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    // Act
    const result = await handleTaskDecomposition(baseArgs, stateDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  // Test 3: Script error (exit 2) returns error response
  it('HandleTaskDecomposition_ScriptError_ReturnsError', async () => {
    // Arrange
    const error = new Error('Script error') as Error & {
      status: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    error.status = 2;
    error.stdout = Buffer.from('');
    error.stderr = Buffer.from('Error: Plan file not found');
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    // Act
    const result = await handleTaskDecomposition(baseArgs, stateDir);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_ERROR');
  });

  // Test 4: Parses metrics correctly from output
  it('HandleTaskDecomposition_ParsesMetrics', async () => {
    // Arrange
    mockedExecSync.mockReturnValue(Buffer.from(PASSING_OUTPUT));

    // Act
    const result = await handleTaskDecomposition(baseArgs, stateDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      wellDecomposed: number;
      needsRework: number;
      totalTasks: number;
    };
    expect(data.wellDecomposed).toBe(2);
    expect(data.needsRework).toBe(0);
    expect(data.totalTasks).toBe(2);
  });

  // Test 5: Missing featureId returns validation error
  it('HandleTaskDecomposition_MissingFeatureId_ReturnsError', async () => {
    // Arrange
    const args = { featureId: '', planPath: 'docs/plans/test.md' };

    // Act
    const result = await handleTaskDecomposition(args, stateDir);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  // Test 6: Missing planPath returns validation error
  it('HandleTaskDecomposition_MissingPlanPath_ReturnsError', async () => {
    // Arrange
    const args = { featureId: 'test-feature', planPath: '' };

    // Act
    const result = await handleTaskDecomposition(args, stateDir);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});
