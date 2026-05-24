// ─── Static Analysis Action Tests ────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';

// ─── Mock the pure TS static analysis module ────────────────────────────────

const mockRunStaticAnalysis = vi.fn();

vi.mock('./pure/static-analysis.js', () => ({
  runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { handleStaticAnalysis } from './static-analysis.js';

const STATE_DIR = '/tmp/test-static-analysis';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassingResult() {
  return {
    status: 'pass' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/project`',
      '',
      '- **PASS**: Lint',
      '- **PASS**: Typecheck',
      '',
      '---',
      '',
      '**Result: PASS** (2/2 checks passed)',
    ].join('\n'),
    passCount: 2,
    failCount: 0,
  };
}

function makeFailingResult() {
  return {
    status: 'fail' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/project`',
      '',
      '- **PASS**: Lint',
      '- **FAIL**: Typecheck — npm run typecheck failed',
      '',
      '---',
      '',
      '**Result: FAIL** (1/2 checks failed)',
    ].join('\n'),
    passCount: 1,
    failCount: 1,
  };
}

function makeErrorResult() {
  return {
    status: 'error' as const,
    output: '',
    error: 'No package.json found at /nonexistent',
    passCount: 0,
    failCount: 0,
  };
}

function makeSkipResult() {
  return {
    status: 'skip' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/empty-repo`',
      '',
      '- **SKIP**: No recognized project type (no package.json, *.csproj, go.mod, or Cargo.toml)',
      '',
      '---',
      '',
      '**Result: SKIP** (no applicable toolchain detected)',
    ].join('\n'),
    skipReason: 'no-toolchain' as const,
    passCount: 0,
    failCount: 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleStaticAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleStaticAnalysis_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── All Checks Passing ────────────────────────────────────────────────

  describe('all checks passing', () => {
    it('handleStaticAnalysis_AllChecksPassing_ReturnsPassed', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.passCount).toBe(2);
      expect(data.failCount).toBe(0);
      expect(data.report).toContain('Static Analysis Report');
    });
  });

  // ─── Errors Found ─────────────────────────────────────────────────────

  describe('errors found', () => {
    it('handleStaticAnalysis_ErrorsFound_ReturnsFailWithFindings', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makeFailingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.passCount).toBe(1);
      expect(data.failCount).toBe(1);
      expect(data.report).toContain('FAIL');
      expect(data.report).toContain('Typecheck');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleStaticAnalysis_EmitsGateExecutedEvent', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('static-analysis');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D2',
        phase: 'delegate',
        passCount: 2,
        failCount: 0,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleStaticAnalysis_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          details: Record<string, unknown>;
        };
      };
      expect(event.data.details.phase).toBe('delegate');
    });
  });

  // ─── Error Status (e.g., no package.json) ──────────────────────────────

  describe('error status from analysis', () => {
    it('handleStaticAnalysis_ErrorStatus_ReturnsScriptError', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makeErrorResult());

      const args = { featureId: 'feat-1', repoRoot: '/nonexistent' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('No package.json found');
    });
  });

  // ─── Skip Status (T-10: no-toolchain inconclusive) ───────────────────

  describe('skip status from analysis', () => {
    it('handleStaticAnalysis_SkipStatus_EmitsEventWithSkippedTrue', async () => {
      // Arrange: pure function reports skip / no-toolchain.
      mockRunStaticAnalysis.mockReturnValue(makeSkipResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/empty-repo' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert: handler returns success with passed=false + skipped=true.
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        skipped: boolean;
        skipReason?: string;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.skipped).toBe(true);
      expect(data.skipReason).toBe('no-toolchain');
      expect(data.passCount).toBe(0);
      expect(data.failCount).toBe(0);
      expect(data.report).toContain('Result: SKIP');

      // Assert: gate.executed event reflects skip in details payload.
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('static-analysis');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(false);
      expect(event.data.details.dimension).toBe('D2');
      expect(event.data.details.skipped).toBe(true);
      expect(event.data.details.skipReason).toBe('no-toolchain');
    });
  });

  // ─── Skip Flags ───────────────────────────────────────────────────────

  describe('skip flags', () => {
    it('handleStaticAnalysis_SkipFlags_PassedToFunction', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = {
        featureId: 'feat-1',
        repoRoot: '/home/user/project',
        skipLint: true,
        skipTypecheck: true,
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        repoRoot: string;
        skipLint: boolean;
        skipTypecheck: boolean;
        runCommand: unknown;
      };
      expect(callArgs.repoRoot).toBe('/home/user/project');
      expect(callArgs.skipLint).toBe(true);
      expect(callArgs.skipTypecheck).toBe(true);
      expect(callArgs.runCommand).toBeDefined();
    });
  });

  // ─── Worktree-aware repoRoot resolution (#1330 / T-04) ──────────────────

  describe('worktree-aware repoRoot resolution', () => {
    it('CheckStaticAnalysis_DiffOnlyInWorktree_RunsTscAgainstWorktree', async () => {
      // Arrange: the agent's diff lives in a worktree path distinct from the
      // orchestrator's process.cwd(). Passing that path as repoRoot must make
      // the gate run tsc (via the injected runCommand cwd) against the worktree,
      // NOT against process.cwd() which lacks the agent's changes (#1330).
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-feat-1';
      expect(worktreePath).not.toBe(process.cwd());

      const args = { featureId: 'feat-1', repoRoot: worktreePath };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert: the pure analysis (which forwards repoRoot as the runCommand
      // cwd) was invoked against the worktree path.
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_ResolvesWorktreePathArg', async () => {
      // Arrange: repoRoot: 'auto' with an explicit worktreePath arg resolves to
      // the worktree path (the preferred resolver seam for T-05).
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-feat-1';

      const args = {
        featureId: 'feat-1',
        repoRoot: 'auto' as const,
        worktreePath,
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_ResolvesFromWorktreeCreatedEvent', async () => {
      // Arrange: repoRoot: 'auto' with no worktreePath arg falls back to the
      // latest worktree.created event recorded for taskId on the feature stream.
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-task-9';
      mockStore.query.mockResolvedValue([
        { type: 'worktree.created', data: { taskId: 'task-9', path: worktreePath } },
      ]);

      const args = {
        featureId: 'feat-1',
        repoRoot: 'auto' as const,
        taskId: 'task-9',
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_Unresolvable_ReturnsError', async () => {
      // Arrange: 'auto' with neither a worktreePath arg nor a worktree.created
      // event is unresolvable — must error rather than silently falling back to
      // process.cwd() (the #1330 coin-flip we are eliminating).
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      mockStore.query.mockResolvedValue([]);

      const args = { featureId: 'feat-1', repoRoot: 'auto' as const, taskId: 'task-9' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(mockRunStaticAnalysis).not.toHaveBeenCalled();
    });

    it('CheckStaticAnalysis_NoRepoRoot_DefaultsToProcessCwd', async () => {
      // Arrange: regression guard — omitting repoRoot keeps the existing
      // process.cwd() default for non-delegation callers.
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(process.cwd());
    });
  });

  // ─── runCommand adapter is passed ──────────────────────────────────────

  describe('runCommand adapter', () => {
    it('handleStaticAnalysis_PassesRunCommandAdapter', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        runCommand: unknown;
      };
      expect(typeof callArgs.runCommand).toBe('function');
    });
  });
});
