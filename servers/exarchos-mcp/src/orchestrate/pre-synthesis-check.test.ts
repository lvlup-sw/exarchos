// ─── Pre-Synthesis Check Handler Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock node:fs ───────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

// ─── Mock node:child_process ────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { handlePreSynthesisCheck } from './pre-synthesis-check.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

interface CheckReport {
  passed: boolean;
  report: string;
  checks: { pass: number; fail: number; skip: number };
}

function makeState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'synthesize',
    workflowType: 'feature',
    tasks: [
      { id: 'T1', status: 'complete' },
      { id: 'T2', status: 'complete' },
    ],
    reviews: {
      overall: { status: 'approved' },
    },
    ...overrides,
  });
}

function setupValidState(stateJson: string): void {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(stateJson);
}

/**
 * Mock execFileSync for check 6 (stack) + execSync for check 7 (tests).
 * git/gh calls use execFileSync with encoding:'utf-8' → return string.
 * Test/typecheck calls use execSync (shell command strings).
 */
function mockStackAndTests(): void {
  vi.mocked(execFileSync)
    .mockReturnValueOnce('feature-branch\n' as unknown as Buffer)  // git branch --show-current
    .mockReturnValueOnce('[{"number":1}]' as unknown as Buffer);   // gh pr list
  vi.mocked(execSync)
    .mockReturnValueOnce(Buffer.from('Tests: 5 passed'))           // test command
    .mockReturnValueOnce(Buffer.from(''));                           // typecheck command
}

/** Mock execFileSync for stack-only (when tests are skipped). */
function mockStackOnly(): void {
  vi.mocked(execFileSync)
    .mockReturnValueOnce('feature-branch\n' as unknown as Buffer)  // git branch --show-current
    .mockReturnValueOnce('[{"number":1}]' as unknown as Buffer);   // gh pr list
}

/** Mock execSync for tests-only (when stack is skipped). */
function mockTestsOnly(): void {
  vi.mocked(execSync)
    .mockReturnValueOnce(Buffer.from('Tests: 5 passed'))           // test command
    .mockReturnValueOnce(Buffer.from(''));                           // typecheck command
}

describe('handlePreSynthesisCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1: All checks pass ────────────────────────────────────────────

  it('AllChecksPass_ReturnsPassed', () => {
    // Arrange
    setupValidState(makeState());
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.checks.pass).toBeGreaterThanOrEqual(5);
  });

  // ─── Test 2: State file not found ───────────────────────────────────────

  it('StateFileNotFound_ReturnsError', () => {
    // Arrange
    vi.mocked(existsSync).mockReturnValue(false);

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/missing.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('not found');
  });

  // ─── Test 3: Phase not synthesize → passed: false with transition guidance

  it('PhaseNotSynthesize_ReturnsFailWithGuidance', () => {
    // Arrange — feature workflow at review phase
    setupValidState(makeState({ phase: 'review' }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('allReviewsPassed');
  });

  // ─── Test 4: Incomplete tasks → passed: false ──────────────────────────

  it('IncompleteTasks_ReturnsFailWithDetails', () => {
    // Arrange
    setupValidState(makeState({
      tasks: [
        { id: 'T1', status: 'complete' },
        { id: 'T2', status: 'in-progress' },
        { id: 'T3', status: 'assigned' },
      ],
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('T2');
    expect(data.report).toContain('T3');
  });

  // ─── Test 5: Reviews not passed → passed: false ────────────────────────

  it('ReviewsNotPassed_ReturnsFailWithDetails', () => {
    // Arrange
    setupValidState(makeState({
      reviews: { overall: { status: 'rejected' } },
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('overall');
  });

  // ─── Test 6: Tasks with needs_fixes → passed: false ────────────────────

  it('TasksNeedsFixes_ReturnsFailWithDetails', () => {
    // Arrange
    setupValidState(makeState({
      tasks: [
        { id: 'T1', status: 'complete' },
        { id: 'T2', status: 'needs_fixes' },
      ],
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('needs_fixes');
    expect(data.report).toContain('T2');
  });

  // ─── Test 7: skipTests=true → skips test execution ─────────────────────

  it('SkipTests_SkipsTestExecution', () => {
    // Arrange
    setupValidState(makeState());
    mockStackOnly();

    // Act
    const result = handlePreSynthesisCheck({
      stateFile: '/tmp/state.json',
      skipTests: true,
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('SKIP');
    // Verify test commands were NOT called via execSync
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  // ─── Test 8: skipStack=true → skips PR stack check ─────────────────────

  it('SkipStack_SkipsPrStackCheck', () => {
    // Arrange
    setupValidState(makeState());
    mockTestsOnly();

    // Act
    const result = handlePreSynthesisCheck({
      stateFile: '/tmp/state.json',
      skipStack: true,
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('SKIP');
  });

  // ─── Test 9: Multiple review shapes handled correctly ──────────────────

  it('MultipleReviewShapes_AllHandledCorrectly', () => {
    // Arrange — flat, nested, and legacy review shapes all passing
    setupValidState(makeState({
      reviews: {
        overhaul: { status: 'approved' },
        T1: {
          specReview: { status: 'pass' },
          qualityReview: { status: 'approved' },
        },
        T2: { passed: true },
      },
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.report).not.toContain('FAIL');
  });

  // ─── Test 10: Nested review shape with failures ────────────────────────

  it('NestedReviewShape_FailingSubReview_Detected', () => {
    // Arrange
    setupValidState(makeState({
      reviews: {
        T1: {
          specReview: { status: 'pass' },
          qualityReview: { status: 'rejected' },
        },
      },
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('qualityReview');
  });

  // ─── Test 11: Legacy review shape with passed: false ───────────────────

  it('LegacyReviewShape_PassedFalse_Detected', () => {
    // Arrange
    setupValidState(makeState({
      reviews: { T1: { passed: false } },
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('T1');
  });

  // ─── Test 12: Invalid JSON state file ──────────────────────────────────

  it('InvalidJson_ReturnsFailWithDetail', () => {
    // Arrange
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ invalid json }');

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('Invalid JSON');
  });

  // ─── Test 13: No tasks → fail ──────────────────────────────────────────

  it('NoTasks_ReturnsFailWithDetail', () => {
    // Arrange
    setupValidState(makeState({ tasks: [] }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No tasks found');
  });

  // ─── Test 14: No reviews → fail ────────────────────────────────────────

  it('NoReviews_ReturnsFailWithDetail', () => {
    // Arrange
    setupValidState(makeState({ reviews: {} }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No review entries');
  });

  // ─── Test 15: Refactor overhaul-update-docs phase → transition guidance

  it('RefactorOverhaulUpdateDocs_ShowsTransitionGuidance', () => {
    // Arrange
    setupValidState(makeState({
      phase: 'overhaul-update-docs',
      workflowType: 'refactor',
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('docsUpdated');
  });

  // ─── Test 16: Debug workflow debug-review phase → transition guidance ──

  it('DebugReviewPhase_ShowsTransitionGuidance', () => {
    // Arrange
    setupValidState(makeState({
      phase: 'debug-review',
      workflowType: 'debug',
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('reviewPassed');
  });

  // ─── Test 17: Refactor polish track → not synthesis-eligible ───────────

  it('RefactorPolishTrack_NotSynthesisEligible', () => {
    // Arrange
    setupValidState(makeState({
      phase: 'polish-implement',
      workflowType: 'refactor',
    }));
    mockStackAndTests();

    // Act
    const result = handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('polish track');
  });
});
