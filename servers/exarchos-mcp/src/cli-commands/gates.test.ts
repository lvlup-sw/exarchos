import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Shared state for CAS race simulation — accessible to the fs mock below
const casRaceConfig = vi.hoisted(() => ({
  targetPath: null as string | null,
  readCount: 0,
  concurrentState: null as Record<string, unknown> | null,
}));

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock the hook event sidecar writer so gates.ts calls are intercepted
vi.mock('../event-store/hook-event-writer.js', () => ({
  writeHookEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock detect-test-commands — defaults to returning npm typecheck/test:run
// so existing tests continue to work. Individual tests can override via mockDetect.
vi.mock('../orchestrate/detect-test-commands.js', () => ({
  detectTestCommands: vi.fn().mockReturnValue({
    typecheck: 'npm run typecheck',
    test: 'npm run test:run',
  }),
}));

// Wrap node:fs/promises readFile to support CAS race simulation.
// All other functions pass through to the real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      const filePath = typeof args[0] === 'string' ? args[0] : '';
      if (
        casRaceConfig.targetPath &&
        filePath === casRaceConfig.targetPath &&
        casRaceConfig.concurrentState
      ) {
        casRaceConfig.readCount += 1;
        if (casRaceConfig.readCount === 1) {
          // After the first read of the target state file, simulate a concurrent
          // writer modifying the file on disk before the caller can write back.
          await actual.writeFile(
            casRaceConfig.targetPath,
            JSON.stringify(casRaceConfig.concurrentState, null, 2),
          );
        }
      }
      return result;
    },
  };
});

import { execSync } from 'node:child_process';
import { writeHookEvent } from '../event-store/hook-event-writer.js';
import { detectTestCommands } from '../orchestrate/detect-test-commands.js';
import { handleTaskGate, handleTeammateGate, runQualityChecks, findActiveWorkflowState, findUnblockedTasks, resetQualityRetries, readTeamConfig, resolveTeammateFromConfig } from './gates.js';
import type { CommandResult } from '../cli.js';

const mockExecSync = vi.mocked(execSync);
const mockDetectTestCommands = vi.mocked(detectTestCommands);

describe('Quality Gate Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset CAS race config to prevent leaks between tests
    casRaceConfig.targetPath = null;
    casRaceConfig.readCount = 0;
    casRaceConfig.concurrentState = null;
  });

  describe('handleTaskGate', () => {
    it('should parse TaskCompleted input with task_subject correctly', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'Implement user auth',
        task_output: 'All tests pass',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTaskGate(input);

      // Assert — should not error on valid input
      expect(result.error).toBeUndefined();
    });

    it('should return continue true when all checks pass', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'Add feature X',
        task_output: 'Done',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTaskGate(input);

      // Assert
      expect(result).toEqual({ continue: true });
    });

    it('should return GATE_FAILED error when typecheck fails', async () => {
      // Arrange
      const typecheckError = new Error('Type checking failed');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from(
        "src/foo.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      );

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typecheck')) {
          throw typecheckError;
        }
        return Buffer.from('');
      });

      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'Add feature X',
        task_output: 'Done',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTaskGate(input);

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('GATE_FAILED');
      expect(result.error!.message).toContain('typecheck');
    });

    it('should return GATE_FAILED error when tests fail', async () => {
      // Arrange
      const testError = new Error('Tests failed');
      (testError as NodeJS.ErrnoException).status = 1;
      (testError as unknown as { stdout: Buffer }).stdout = Buffer.from('FAIL src/foo.test.ts');
      (testError as unknown as { stderr: Buffer }).stderr = Buffer.from('');

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('test:run')) {
          throw testError;
        }
        return Buffer.from('');
      });

      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'Add feature X',
        task_output: 'Done',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTaskGate(input);

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('GATE_FAILED');
      expect(result.error!.message).toContain('test');
    });

    it('should return GATE_FAILED error when worktree has uncommitted changes', async () => {
      // Arrange
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('git status')) {
          return Buffer.from(' M src/foo.ts\n?? src/bar.ts\n');
        }
        return Buffer.from('');
      });

      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'Add feature X',
        task_output: 'Done',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTaskGate(input);

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('GATE_FAILED');
      expect(result.error!.message).toContain('uncommitted');
    });

    it('should return INVALID_INPUT error when cwd is missing', async () => {
      // Arrange
      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'Add feature X',
        task_output: 'Done',
      };

      // Act
      const result = await handleTaskGate(input);

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INVALID_INPUT');
    });

    it('should run checks in the cwd from stdin', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const input: Record<string, unknown> = {
        hook_event_name: 'TaskCompleted',
        task_subject: 'task',
        task_output: 'output',
        cwd: '/my/specific/worktree',
      };

      // Act
      await handleTaskGate(input);

      // Assert — verify execSync was called with the correct cwd
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('typecheck'),
        expect.objectContaining({ cwd: '/my/specific/worktree' }),
      );
    });

    // ─── Task 005: Workflow Bypass ────────────────────────────────────────────

    describe('workflow bypass', () => {
      let tempStateDir: string;
      const originalEnv = process.env.WORKFLOW_STATE_DIR;

      beforeEach(() => {
        tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-gate-bypass-'));
        process.env.WORKFLOW_STATE_DIR = tempStateDir;
      });

      afterEach(async () => {
        process.env.WORKFLOW_STATE_DIR = originalEnv;
        await fsp.rm(tempStateDir, { recursive: true, force: true });
      });

      it('HandleTaskGate_ActiveWorkflow_BypassesChecks', async () => {
        // Arrange — create a valid active workflow state file with matching worktree
        const state = {
          featureId: 'test',
          phase: 'delegate',
          tasks: [],
          worktrees: { 'wt-001': { branch: 'feat/task-001', taskId: 'task-001', status: 'active', path: '/some/path' } },
          _version: 1,
        };
        await fsp.writeFile(
          path.join(tempStateDir, 'test.state.json'),
          JSON.stringify(state),
        );
        mockExecSync.mockReturnValue(Buffer.from(''));

        const input: Record<string, unknown> = {
          hook_event_name: 'TaskCompleted',
          task_subject: 'Implement feature',
          task_output: 'Done',
          cwd: '/some/path',
        };

        // Act
        const result = await handleTaskGate(input);

        // Assert — should bypass checks and return continue: true
        expect(result.continue).toBe(true);
        expect(mockExecSync).not.toHaveBeenCalled();
      });

      it('HandleTaskGate_NoWorkflow_RunsChecks', async () => {
        // Arrange — empty state dir (no workflow state files)
        mockExecSync.mockReturnValue(Buffer.from(''));

        const input: Record<string, unknown> = {
          hook_event_name: 'TaskCompleted',
          task_subject: 'Implement feature',
          task_output: 'Done',
          cwd: '/some/path',
        };

        // Act
        const result = await handleTaskGate(input);

        // Assert — checks should have been executed
        expect(mockExecSync).toHaveBeenCalled();
        expect(result.error).toBeUndefined();
      });
    });
  });

  // ─── Task 005: Stderr Feedback in Quality Checks ─────────────────────────

  describe('RunQualityChecks error detail', () => {
    it('RunQualityChecks_GateFails_ReturnsErrorWithDetail', async () => {
      // Arrange — make typecheck fail with stderr content
      const typecheckError = new Error('typecheck failed');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from(
        "src/foo.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      );

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typecheck')) {
          throw typecheckError;
        }
        return Buffer.from('');
      });

      // Act
      const result = await runQualityChecks('/tmp/worktree');

      // Assert — error includes the failure label AND stderr content
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('GATE_FAILED');
      expect(result.error!.message).toContain('typecheck');
      expect(result.error!.message).toContain('TS2322');
      expect(result.error!.message).toContain("Type 'string' is not assignable to type 'number'");
    });

    it('RunQualityChecks_NoTestsDetected_SkipsTestAndTypecheck', async () => {
      // Arrange — detectTestCommands returns null for both
      mockDetectTestCommands.mockReturnValueOnce({ test: null, typecheck: null });
      mockExecSync.mockReturnValue(Buffer.from(''));

      // Act
      const result = await runQualityChecks('/tmp/worktree');

      // Assert — only git status should be called (clean-worktree check)
      expect(result).toEqual({ continue: true });
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync).toHaveBeenCalledWith(
        'git status --porcelain',
        expect.objectContaining({ cwd: '/tmp/worktree' }),
      );
    });

    it('RunQualityChecks_CustomTestCommand_UsesDetectedCommand', async () => {
      // Arrange — detectTestCommands returns custom commands
      mockDetectTestCommands.mockReturnValueOnce({ test: 'cargo test', typecheck: 'cargo check' });
      mockExecSync.mockReturnValue(Buffer.from(''));

      // Act
      const result = await runQualityChecks('/tmp/worktree');

      // Assert — cargo commands should be called
      expect(result).toEqual({ continue: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        'cargo check',
        expect.objectContaining({ cwd: '/tmp/worktree' }),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'cargo test',
        expect.objectContaining({ cwd: '/tmp/worktree' }),
      );
    });
  });

  describe('handleTeammateGate', () => {
    it('should parse TeammateIdle input with teammate_name correctly', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Assert — should not error on valid input
      expect(result.error).toBeUndefined();
    });

    it('should return continue true when all checks pass', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/worktree',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Assert
      expect(result).toEqual({ continue: true });
    });

    it('should return INVALID_INPUT error when cwd is missing', async () => {
      // Arrange
      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INVALID_INPUT');
    });

    describe('state bridge (workflow state updates)', () => {
      let tempDir: string;
      const originalEnv = process.env.WORKFLOW_STATE_DIR;

      beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-state-test-'));
        process.env.WORKFLOW_STATE_DIR = tempDir;
      });

      afterEach(async () => {
        process.env.WORKFLOW_STATE_DIR = originalEnv;
        await fsp.rm(tempDir, { recursive: true, force: true });
      });

      it('should NOT update task status in state file when quality checks pass (single-writer)', async () => {
        // Arrange
        mockExecSync.mockReturnValue(Buffer.from(''));
        const state = {
          featureId: 'test-workflow',
          phase: 'overhaul-delegate',
          tasks: [
            { id: 'task-001', title: 'Test task', status: 'in_progress', branch: 'feat/test' },
          ],
          worktrees: {
            'wt-001': {
              branch: 'feat/test',
              status: 'active',
              taskId: 'task-001',
              path: '/tmp/worktree',
            },
          },
          _version: 1,
        };
        await fsp.writeFile(
          path.join(tempDir, 'test-workflow.state.json'),
          JSON.stringify(state),
        );

        const input: Record<string, unknown> = {
          hook_event_name: 'TeammateIdle',
          teammate_name: 'worker-1',
          cwd: '/tmp/worktree',
        };

        // Act
        const result = await handleTeammateGate(input);

        // Assert — gate still returns success
        expect(result).toEqual({ continue: true });

        // Assert — state file should NOT be mutated (single-writer: only orchestrator writes tasks[])
        const updatedRaw = await fsp.readFile(
          path.join(tempDir, 'test-workflow.state.json'),
          'utf-8',
        );
        const updatedState = JSON.parse(updatedRaw);
        expect(updatedState.tasks[0].status).toBe('in_progress');
        expect(updatedState.tasks[0].completedAt).toBeUndefined();
        expect(updatedState._version).toBe(1);
      });

      it('should still return success when no active workflow exists', async () => {
        // Arrange — empty state directory
        mockExecSync.mockReturnValue(Buffer.from(''));
        const input: Record<string, unknown> = {
          hook_event_name: 'TeammateIdle',
          teammate_name: 'worker-1',
          cwd: '/tmp/worktree',
        };

        // Act
        const result = await handleTeammateGate(input);

        // Assert
        expect(result).toEqual({ continue: true });
      });

      it('should still return success when cwd does not match any worktree', async () => {
        // Arrange
        mockExecSync.mockReturnValue(Buffer.from(''));
        const state = {
          featureId: 'test-workflow',
          phase: 'overhaul-delegate',
          tasks: [
            { id: 'task-001', title: 'Test task', status: 'in_progress', branch: 'feat/test' },
          ],
          worktrees: {
            'wt-001': {
              branch: 'feat/test',
              status: 'active',
              taskId: 'task-001',
              path: '/other/path',
            },
          },
          _version: 1,
        };
        await fsp.writeFile(
          path.join(tempDir, 'test-workflow.state.json'),
          JSON.stringify(state),
        );

        const input: Record<string, unknown> = {
          hook_event_name: 'TeammateIdle',
          teammate_name: 'worker-1',
          cwd: '/tmp/worktree',
        };

        // Act
        const result = await handleTeammateGate(input);

        // Assert — gate returns success
        expect(result).toEqual({ continue: true });

        // Assert — state file unchanged
        const updatedRaw = await fsp.readFile(
          path.join(tempDir, 'test-workflow.state.json'),
          'utf-8',
        );
        const updatedState = JSON.parse(updatedRaw);
        expect(updatedState.tasks[0].status).toBe('in_progress');
        expect(updatedState._version).toBe(1);
      });

      it('should still return success when state write fails', async () => {
        // Arrange
        mockExecSync.mockReturnValue(Buffer.from(''));
        const state = {
          featureId: 'test-workflow',
          phase: 'overhaul-delegate',
          tasks: [
            { id: 'task-001', title: 'Test task', status: 'in_progress', branch: 'feat/test' },
          ],
          worktrees: {
            'wt-001': {
              branch: 'feat/test',
              status: 'active',
              taskId: 'task-001',
              path: '/tmp/worktree',
            },
          },
          _version: 1,
        };
        await fsp.writeFile(
          path.join(tempDir, 'test-workflow.state.json'),
          JSON.stringify(state),
        );

        // Make state dir read-only to force write failure
        await fsp.chmod(path.join(tempDir, 'test-workflow.state.json'), 0o444);

        const input: Record<string, unknown> = {
          hook_event_name: 'TeammateIdle',
          teammate_name: 'worker-1',
          cwd: '/tmp/worktree',
        };

        // Act
        const result = await handleTeammateGate(input);

        // Assert — gate still succeeds even though write failed
        expect(result).toEqual({ continue: true });

        // Cleanup — restore write permission so afterEach can delete
        await fsp.chmod(path.join(tempDir, 'test-workflow.state.json'), 0o644);
      });

      it('should not update task when quality checks fail', async () => {
        // Arrange
        const typecheckError = new Error('Type checking failed');
        (typecheckError as NodeJS.ErrnoException).status = 1;
        (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
        (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from('type error');

        mockExecSync.mockImplementation((cmd: string) => {
          if (typeof cmd === 'string' && cmd.includes('typecheck')) {
            throw typecheckError;
          }
          return Buffer.from('');
        });

        const state = {
          featureId: 'test-workflow',
          phase: 'overhaul-delegate',
          tasks: [
            { id: 'task-001', title: 'Test task', status: 'in_progress', branch: 'feat/test' },
          ],
          worktrees: {
            'wt-001': {
              branch: 'feat/test',
              status: 'active',
              taskId: 'task-001',
              path: '/tmp/worktree',
            },
          },
          _version: 1,
        };
        await fsp.writeFile(
          path.join(tempDir, 'test-workflow.state.json'),
          JSON.stringify(state),
        );

        const input: Record<string, unknown> = {
          hook_event_name: 'TeammateIdle',
          teammate_name: 'worker-1',
          cwd: '/tmp/worktree',
        };

        // Act
        const result = await handleTeammateGate(input);

        // Assert — gate fails
        expect(result.error).toBeDefined();
        expect(result.error!.code).toBe('GATE_FAILED');

        // Assert — state file unchanged
        const updatedRaw = await fsp.readFile(
          path.join(tempDir, 'test-workflow.state.json'),
          'utf-8',
        );
        const updatedState = JSON.parse(updatedRaw);
        expect(updatedState.tasks[0].status).toBe('in_progress');
        expect(updatedState._version).toBe(1);
      });

      it('should never write to state file even when concurrent writes occur (single-writer)', async () => {
        // Arrange — initial state at version 1
        mockExecSync.mockReturnValue(Buffer.from(''));
        const stateFilePath = path.join(tempDir, 'test-workflow.state.json');
        const initialState = {
          featureId: 'test-workflow',
          phase: 'overhaul-delegate',
          tasks: [
            { id: 'task-001', title: 'Test task', status: 'in_progress', branch: 'feat/test' },
          ],
          worktrees: {
            'wt-001': {
              branch: 'feat/test',
              status: 'active',
              taskId: 'task-001',
              path: '/tmp/worktree',
            },
          },
          _version: 1,
        };
        await fsp.writeFile(stateFilePath, JSON.stringify(initialState));

        // Configure the CAS race simulation: after the first readFile of the
        // state file (done by findActiveWorkflowState), the mock will inject
        // a concurrent write that bumps _version to 2 and changes task status.
        casRaceConfig.targetPath = stateFilePath;
        casRaceConfig.readCount = 0;
        casRaceConfig.concurrentState = {
          ...initialState,
          _version: 2,
          tasks: [
            { id: 'task-001', title: 'Test task', status: 'claimed_by_other', branch: 'feat/test' },
          ],
        };

        const input: Record<string, unknown> = {
          hook_event_name: 'TeammateIdle',
          teammate_name: 'worker-1',
          cwd: '/tmp/worktree',
        };

        // Act
        const result = await handleTeammateGate(input);

        // Disable race simulation before reading final state
        casRaceConfig.targetPath = null;
        casRaceConfig.concurrentState = null;

        // Assert — gate still returns success
        expect(result).toEqual({ continue: true });

        // Assert — the concurrent writer's state is preserved because the hook
        // never writes to the state file (single-writer principle)
        const finalRaw = await fsp.readFile(stateFilePath, 'utf-8');
        const finalState = JSON.parse(finalRaw);
        expect(finalState._version).toBe(2);
        expect(finalState.tasks[0].status).toBe('claimed_by_other');
      });
    });
  });

  describe('findActiveWorkflowState', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-test-'));
    });

    afterEach(async () => {
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it('should return state with tasks and worktrees for an active workflow', async () => {
      // Arrange
      const state = {
        featureId: 'refactor-test',
        phase: 'overhaul-delegate',
        tasks: [
          { id: 'task-001', title: 'Test', status: 'in_progress', branch: 'feat/test' },
        ],
        worktrees: {
          'wt-1': {
            branch: 'feat/test',
            status: 'active',
            taskId: 'task-001',
            path: '/tmp/wt',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'refactor-test.state.json'),
        JSON.stringify(state),
      );

      // Act
      const result = await findActiveWorkflowState(tempDir);

      // Assert
      expect(result).not.toBeNull();
      expect(result!.featureId).toBe('refactor-test');
      expect(result!.filePath).toBe(path.join(tempDir, 'refactor-test.state.json'));
      expect(result!.state.tasks).toHaveLength(1);
      expect(result!.state.tasks[0].id).toBe('task-001');
      expect(result!.state.worktrees).toBeDefined();
      expect(result!.state.worktrees['wt-1'].taskId).toBe('task-001');
    });

    it('should return null when no active workflow exists', async () => {
      // Arrange
      const state = {
        featureId: 'done-workflow',
        phase: 'completed',
        tasks: [],
        worktrees: {},
        _version: 5,
      };
      await fsp.writeFile(
        path.join(tempDir, 'done-workflow.state.json'),
        JSON.stringify(state),
      );

      // Act
      const result = await findActiveWorkflowState(tempDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null for empty directory', async () => {
      // Act
      const result = await findActiveWorkflowState(tempDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should skip cancelled workflows', async () => {
      // Arrange
      const state = {
        featureId: 'cancelled-workflow',
        phase: 'cancelled',
        tasks: [],
        worktrees: {},
        _version: 3,
      };
      await fsp.writeFile(
        path.join(tempDir, 'cancelled-workflow.state.json'),
        JSON.stringify(state),
      );

      // Act
      const result = await findActiveWorkflowState(tempDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when directory does not exist', async () => {
      // Act
      const result = await findActiveWorkflowState('/nonexistent/path/abc123');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('runQualityChecks', () => {
    it('should run typecheck, tests, and git status in order', async () => {
      // Arrange
      const callOrder: string[] = [];
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string') {
          if (cmd.includes('typecheck')) callOrder.push('typecheck');
          else if (cmd.includes('test:run')) callOrder.push('test');
          else if (cmd.includes('git status')) callOrder.push('git-status');
        }
        return Buffer.from('');
      });

      // Act
      const result = await runQualityChecks('/tmp/worktree');

      // Assert
      expect(callOrder).toEqual(['typecheck', 'test', 'git-status']);
      expect(result).toEqual({ continue: true });
    });

    it('should stop at first failure and not run subsequent checks', async () => {
      // Arrange
      const callOrder: string[] = [];
      const typecheckError = new Error('fail');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from('type error');
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string') {
          if (cmd.includes('typecheck')) {
            callOrder.push('typecheck');
            throw typecheckError;
          }
          if (cmd.includes('test:run')) callOrder.push('test');
          if (cmd.includes('git status')) callOrder.push('git-status');
        }
        return Buffer.from('');
      });

      // Act
      const result = await runQualityChecks('/tmp/worktree');

      // Assert
      expect(callOrder).toEqual(['typecheck']);
      expect(result.error).toBeDefined();
    });

    it('should use appropriate timeouts for each check', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));

      // Act
      await runQualityChecks('/tmp/worktree');

      // Assert — verify typecheck has 30s timeout
      const typecheckCall = mockExecSync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('typecheck'),
      );
      expect(typecheckCall).toBeDefined();
      expect((typecheckCall![1] as ExecSyncOptions)?.timeout).toBe(30_000);

      // Assert — verify test has 120s timeout
      const testCall = mockExecSync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('test:run'),
      );
      expect(testCall).toBeDefined();
      expect((testCall![1] as ExecSyncOptions)?.timeout).toBe(120_000);
    });

    it('should handle command timeout as a failure', async () => {
      // Arrange
      const timeoutError = new Error('Command timed out');
      (timeoutError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      (timeoutError as unknown as { killed: boolean }).killed = true;
      (timeoutError as unknown as { stderr: Buffer }).stderr = Buffer.from('');
      (timeoutError as unknown as { stdout: Buffer }).stdout = Buffer.from('');

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('test:run')) {
          throw timeoutError;
        }
        return Buffer.from('');
      });

      // Act
      const result = await runQualityChecks('/tmp/worktree');

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('GATE_FAILED');
      expect(result.error!.message).toContain('test');
    });
  });

  // ─── Task 8: Team Event Emission ────────────────────────────────────────────

  describe('team event emission', () => {
    let tempDir: string;
    const originalEnv = process.env.WORKFLOW_STATE_DIR;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-event-test-'));
      process.env.WORKFLOW_STATE_DIR = tempDir;
    });

    afterEach(async () => {
      process.env.WORKFLOW_STATE_DIR = originalEnv;
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    function createActiveState(overrides: {
      taskId?: string;
      taskStatus?: string;
      cwdPath?: string;
      startedAt?: string;
    } = {}): Record<string, unknown> {
      return {
        featureId: 'event-test-workflow',
        phase: 'overhaul-delegate',
        tasks: [
          {
            id: overrides.taskId ?? 'task-evt-001',
            title: 'Event test task',
            status: overrides.taskStatus ?? 'in_progress',
            branch: 'feat/event-test',
            startedAt: overrides.startedAt ?? new Date(Date.now() - 5000).toISOString(),
          },
        ],
        worktrees: {
          'wt-evt-001': {
            branch: 'feat/event-test',
            status: 'active',
            taskId: overrides.taskId ?? 'task-evt-001',
            path: overrides.cwdPath ?? '/tmp/event-worktree',
          },
        },
        _version: 1,
      };
    }

    async function writeStateFile(state: Record<string, unknown>): Promise<void> {
      await fsp.writeFile(
        path.join(tempDir, `${state.featureId as string}.state.json`),
        JSON.stringify(state),
      );
    }

    it('should emit team.task.completed event when quality checks pass', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const mockWrite = vi.mocked(writeHookEvent);
      mockWrite.mockClear();
      const state = createActiveState({ cwdPath: '/tmp/event-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — writeHookEvent should be called with team.task.completed via sidecar
      const completedCalls = mockWrite.mock.calls.filter(
        (call) => call[2].type === 'team.task.completed',
      );
      expect(completedCalls).toHaveLength(1);

      const [, , event] = completedCalls[0];
      expect(event.data.taskId).toBe('task-evt-001');
      expect(event.data.teammateName).toBe('worker-1');
      expect(typeof event.data.durationMs).toBe('number');
      expect((event.data.durationMs as number)).toBeGreaterThan(0);
      expect(event.data.testsPassed).toBe(true);
    });

    it('should not emit team.task.completed event when quality checks fail', async () => {
      // Arrange
      const typecheckError = new Error('Type checking failed');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from('type error');

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typecheck')) {
          throw typecheckError;
        }
        return Buffer.from('');
      });

      const mockWrite = vi.mocked(writeHookEvent);
      mockWrite.mockClear();
      const state = createActiveState({ cwdPath: '/tmp/event-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — no team.task.completed event should be written via sidecar
      const completedCalls = mockWrite.mock.calls.filter(
        (call) => call[2].type === 'team.task.completed',
      );
      expect(completedCalls).toHaveLength(0);
    });

    it('should not emit event when no matching task for cwd', async () => {
      // Arrange — state has a worktree at a different path
      mockExecSync.mockReturnValue(Buffer.from(''));
      const mockWrite = vi.mocked(writeHookEvent);
      mockWrite.mockClear();
      const state = createActiveState({ cwdPath: '/tmp/other-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Assert — no event written via sidecar, but gate still passes
      expect(mockWrite).not.toHaveBeenCalled();
      expect(result.continue).toBe(true);
    });

    it('should include changed files in team.task.completed event', async () => {
      // Arrange — git diff returns a string (encoding: 'utf-8'), quality checks return Buffer
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('git diff --name-only')) {
          return 'src/auth/login.ts\nsrc/api/routes.ts\n';
        }
        return Buffer.from('');
      });

      const mockWrite = vi.mocked(writeHookEvent);
      mockWrite.mockClear();
      const state = createActiveState({ cwdPath: '/tmp/event-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — writeHookEvent called with filesChanged in data via sidecar
      const completedCalls = mockWrite.mock.calls.filter(
        (call) => call[2].type === 'team.task.completed',
      );
      expect(completedCalls).toHaveLength(1);

      const filesChanged = completedCalls[0][2].data.filesChanged as string[];
      expect(filesChanged).toContain('src/auth/login.ts');
      expect(filesChanged).toContain('src/api/routes.ts');
    });
  });

  // ─── Task 9: Follow-up Task Detection ──────────────────────────────────────

  describe('follow-up task detection', () => {
    it('should return dependents when completed task unblocks them', () => {
      // Arrange
      const tasks = [
        { id: 'task-A', title: 'Task A', status: 'complete' },
        { id: 'task-B', title: 'Task B', status: 'pending', blockedBy: ['task-A'] },
      ];

      // Act
      const result = findUnblockedTasks(tasks, 'task-A');

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('task-B');
    });

    it('should return empty when dependent is still blocked by another task', () => {
      // Arrange
      const tasks = [
        { id: 'task-A', title: 'Task A', status: 'complete' },
        { id: 'task-C', title: 'Task C', status: 'pending', blockedBy: ['task-A', 'task-D'] },
        { id: 'task-D', title: 'Task D', status: 'in_progress' },
      ];

      // Act
      const result = findUnblockedTasks(tasks, 'task-A');

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should return empty when no tasks depend on completed task', () => {
      // Arrange
      const tasks = [
        { id: 'task-A', title: 'Task A', status: 'complete' },
        { id: 'task-B', title: 'Task B', status: 'pending' },
      ];

      // Act
      const result = findUnblockedTasks(tasks, 'task-A');

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should include unblockedTasks in handler result when tasks become unblocked', async () => {
      // Arrange
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-unblock-test-'));
      const originalEnv2 = process.env.WORKFLOW_STATE_DIR;
      process.env.WORKFLOW_STATE_DIR = tempDir2;

      mockExecSync.mockReturnValue(Buffer.from(''));
      const state = {
        featureId: 'unblock-test',
        phase: 'overhaul-delegate',
        tasks: [
          { id: 'task-A', title: 'Task A', status: 'in_progress', branch: 'feat/a' },
          { id: 'task-B', title: 'Task B', status: 'pending', branch: 'feat/b', blockedBy: ['task-A'] },
        ],
        worktrees: {
          'wt-001': {
            branch: 'feat/a',
            status: 'active',
            taskId: 'task-A',
            path: '/tmp/unblock-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir2, 'unblock-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/unblock-worktree',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Cleanup
      process.env.WORKFLOW_STATE_DIR = originalEnv2;
      await fsp.rm(tempDir2, { recursive: true, force: true });

      // Assert
      expect(result.continue).toBe(true);
      const unblockedTasks = result.unblockedTasks as Array<{ id: string }>;
      expect(unblockedTasks).toBeDefined();
      expect(unblockedTasks).toHaveLength(1);
      expect(unblockedTasks[0].id).toBe('task-B');
    });
  });

  // ─── Task 14: Retry Circuit Breaker ──────────────────────────────────────────

  describe('retry circuit breaker', () => {
    let tempDir: string;
    const originalEnv = process.env.WORKFLOW_STATE_DIR;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-circuit-test-'));
      process.env.WORKFLOW_STATE_DIR = tempDir;
      // Reset the module-level retry counters between tests
      resetQualityRetries('__all__');
    });

    afterEach(async () => {
      process.env.WORKFLOW_STATE_DIR = originalEnv;
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    function makeQualityFail(): void {
      const typecheckError = new Error('Type checking failed');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from('type error');

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typecheck')) {
          throw typecheckError;
        }
        return Buffer.from('');
      });
    }

    it('should trip circuit breaker after repeated failures', async () => {
      // Arrange
      makeQualityFail();
      const state = {
        featureId: 'circuit-test',
        phase: 'overhaul-delegate',
        tasks: [
          { id: 'task-001', title: 'Circuit test task', status: 'in_progress', branch: 'feat/circuit' },
        ],
        worktrees: {
          'wt-001': {
            branch: 'feat/circuit',
            status: 'active',
            taskId: 'task-001',
            path: '/tmp/circuit-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'circuit-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/circuit-worktree',
      };

      // Act — call 3 times (MAX_QUALITY_RETRIES)
      await handleTeammateGate(input);
      await handleTeammateGate(input);
      const result = await handleTeammateGate(input);

      // Assert — circuit should be open
      expect(result.error).toBeDefined();
      expect(result.circuitOpen).toBe(true);
    });

    it('should reset counter on success', async () => {
      // Arrange — fail once, then succeed
      const typecheckError = new Error('Type checking failed');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from('type error');

      let callCount = 0;
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typecheck')) {
          callCount++;
          if (callCount <= 1) {
            throw typecheckError;
          }
        }
        return Buffer.from('');
      });

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/circuit-reset-worktree',
      };

      // Act — fail once, then succeed
      const failResult = await handleTeammateGate(input);
      const passResult = await handleTeammateGate(input);

      // Assert — circuit should NOT be tripped
      expect(failResult.error).toBeDefined();
      expect(passResult.error).toBeUndefined();
      expect(passResult.circuitOpen).toBeUndefined();
    });

    it('EmitTeamTaskEvent_CircuitBreakerOpened_EmitsTeamTaskFailedEvent', async () => {
      // Arrange
      makeQualityFail();
      const mockWrite = vi.mocked(writeHookEvent);
      mockWrite.mockClear();
      const state = {
        featureId: 'circuit-event-test',
        phase: 'overhaul-delegate',
        tasks: [
          { id: 'task-cb-001', title: 'Circuit breaker event task', status: 'in_progress', branch: 'feat/cb' },
        ],
        worktrees: {
          'wt-cb-001': {
            branch: 'feat/cb',
            status: 'active',
            taskId: 'task-cb-001',
            path: '/tmp/circuit-event-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'circuit-event-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-cb',
        cwd: '/tmp/circuit-event-worktree',
      };

      // Act — call 3 times to trip the circuit breaker
      await handleTeammateGate(input);
      await handleTeammateGate(input);
      const result = await handleTeammateGate(input);

      // Assert — circuit should be open
      expect(result.circuitOpen).toBe(true);

      // Assert — team.task.failed event emitted via sidecar writer
      const failedCalls = mockWrite.mock.calls.filter(
        (call) => call[2].type === 'team.task.failed',
      );
      expect(failedCalls).toHaveLength(1);

      // Verify shape matches TeamTaskFailedData schema
      const event = failedCalls[0][2];
      expect(typeof event.data.taskId).toBe('string');
      expect(typeof event.data.teammateName).toBe('string');
      expect(typeof event.data.failureReason).toBe('string');
      expect(event.data.gateResults).toBeDefined();
      expect(typeof event.data.gateResults).toBe('object');

      // Verify actual values
      expect(event.data.teammateName).toBe('worker-cb');
      expect(event.data.failureReason).toContain('typecheck');
    });

    it('should track different cwds independently', async () => {
      // Arrange
      makeQualityFail();

      const inputA: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/circuit-worktree-A',
      };
      const inputB: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-2',
        cwd: '/tmp/circuit-worktree-B',
      };

      // Act — fail 2 times for A, 1 time for B
      await handleTeammateGate(inputA);
      await handleTeammateGate(inputA);
      await handleTeammateGate(inputB);

      // Neither should have tripped the circuit (A=2 < 3, B=1 < 3)
      const resultA = await handleTeammateGate(inputA); // 3rd for A — should trip
      const resultB = await handleTeammateGate(inputB); // 2nd for B — should NOT trip

      // Assert
      expect(resultA.circuitOpen).toBe(true);
      expect(resultB.circuitOpen).toBeUndefined();
    });
  });

  // ─── Task 004: Team Config Reading ──────────────────────────────────────────

  describe('readTeamConfig', () => {
    let tempTeamsDir: string;

    beforeEach(() => {
      tempTeamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-config-test-'));
    });

    afterEach(async () => {
      await fsp.rm(tempTeamsDir, { recursive: true, force: true });
    });

    it('should return parsed config with members array from directory format', async () => {
      // Arrange — {teamsDir}/{featureId}/config.json
      const featureId = 'my-feature';
      const featureDir = path.join(tempTeamsDir, featureId);
      fs.mkdirSync(featureDir, { recursive: true });
      const config = {
        members: [
          { name: 'worker-1', worktree: '/tmp/wt-1' },
          { name: 'worker-2', worktree: '/tmp/wt-2' },
        ],
      };
      fs.writeFileSync(path.join(featureDir, 'config.json'), JSON.stringify(config));

      // Act
      const result = await readTeamConfig(featureId, tempTeamsDir);

      // Assert
      expect(result).not.toBeNull();
      expect(result!.members).toHaveLength(2);
      expect(result!.members[0].name).toBe('worker-1');
      expect(result!.members[1].name).toBe('worker-2');
    });

    it('should return parsed config from flat file format', async () => {
      // Arrange — {teamsDir}/{featureId}.json
      const featureId = 'flat-feature';
      const config = {
        members: [
          { name: 'agent-a', worktree: '/tmp/wt-a' },
        ],
      };
      fs.writeFileSync(path.join(tempTeamsDir, `${featureId}.json`), JSON.stringify(config));

      // Act
      const result = await readTeamConfig(featureId, tempTeamsDir);

      // Assert
      expect(result).not.toBeNull();
      expect(result!.members).toHaveLength(1);
      expect(result!.members[0].name).toBe('agent-a');
    });

    it('should prefer directory format over flat file format', async () => {
      // Arrange — both formats exist
      const featureId = 'both-formats';
      const featureDir = path.join(tempTeamsDir, featureId);
      fs.mkdirSync(featureDir, { recursive: true });
      const dirConfig = {
        members: [{ name: 'dir-worker', worktree: '/tmp/dir-wt' }],
      };
      const flatConfig = {
        members: [{ name: 'flat-worker', worktree: '/tmp/flat-wt' }],
      };
      fs.writeFileSync(path.join(featureDir, 'config.json'), JSON.stringify(dirConfig));
      fs.writeFileSync(path.join(tempTeamsDir, `${featureId}.json`), JSON.stringify(flatConfig));

      // Act
      const result = await readTeamConfig(featureId, tempTeamsDir);

      // Assert — directory format wins
      expect(result).not.toBeNull();
      expect(result!.members[0].name).toBe('dir-worker');
    });

    it('should return null when no config file exists', async () => {
      // Act
      const result = await readTeamConfig('nonexistent-feature', tempTeamsDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null for malformed JSON', async () => {
      // Arrange
      const featureId = 'bad-json';
      fs.writeFileSync(path.join(tempTeamsDir, `${featureId}.json`), '{ not valid json!!!');

      // Act
      const result = await readTeamConfig(featureId, tempTeamsDir);

      // Assert
      expect(result).toBeNull();
    });
  });

  // ─── Task 004: Teammate Resolution from Config ──────────────────────────────

  describe('resolveTeammateFromConfig', () => {
    it('should match teammate by worktree path', () => {
      // Arrange
      const config = {
        members: [
          { name: 'worker-1', worktree: '/tmp/wt-1' },
          { name: 'worker-2', worktree: '/tmp/wt-2' },
        ],
      };

      // Act
      const result = resolveTeammateFromConfig(config, '/tmp/wt-2');

      // Assert
      expect(result).toBe('worker-2');
    });

    it('should return fallback inputName when no worktree matches', () => {
      // Arrange
      const config = {
        members: [
          { name: 'worker-1', worktree: '/tmp/wt-1' },
        ],
      };

      // Act
      const result = resolveTeammateFromConfig(config, '/tmp/unknown-wt', 'fallback-agent');

      // Assert
      expect(result).toBe('fallback-agent');
    });

    it('should return unknown when no match and no fallback', () => {
      // Arrange
      const config = {
        members: [
          { name: 'worker-1', worktree: '/tmp/wt-1' },
        ],
      };

      // Act
      const result = resolveTeammateFromConfig(config, '/tmp/unknown-wt');

      // Assert
      expect(result).toBe('unknown');
    });

    it('should return null config fallback from inputName', () => {
      // Act — config is null
      const result = resolveTeammateFromConfig(null, '/tmp/some-wt', 'my-agent');

      // Assert
      expect(result).toBe('my-agent');
    });
  });

  // ─── Sidecar Writer Migration ──────────────────────────────────────────────

  describe('sidecar writer migration', () => {
    let tempDir: string;
    const originalEnv = process.env.WORKFLOW_STATE_DIR;
    const mockWriteHookEvent = vi.mocked(writeHookEvent);

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sidecar-test-'));
      process.env.WORKFLOW_STATE_DIR = tempDir;
      mockWriteHookEvent.mockClear();
    });

    afterEach(async () => {
      process.env.WORKFLOW_STATE_DIR = originalEnv;
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it('emitTeamTaskEvent_OnSuccess_WritesSidecarWithIdempotencyKey', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const state = {
        featureId: 'sidecar-test',
        phase: 'overhaul-delegate',
        tasks: [
          {
            id: 'task-sc-001',
            title: 'Sidecar test task',
            status: 'in_progress',
            branch: 'feat/sc',
            startedAt: new Date(Date.now() - 5000).toISOString(),
          },
        ],
        worktrees: {
          'wt-sc-001': {
            branch: 'feat/sc',
            status: 'active',
            taskId: 'task-sc-001',
            path: '/tmp/sidecar-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'sidecar-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-sc',
        cwd: '/tmp/sidecar-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — writeHookEvent should be called with team.task.completed and idempotency key
      expect(mockWriteHookEvent).toHaveBeenCalledTimes(1);
      const [stateDir, streamId, event] = mockWriteHookEvent.mock.calls[0];
      expect(stateDir).toBe(tempDir);
      expect(streamId).toBe('sidecar-test');
      expect(event.type).toBe('team.task.completed');
      expect(event.idempotencyKey).toBe('sidecar-test:team.task.completed:task-sc-001');
      expect(event.data.taskId).toBe('task-sc-001');
      expect(event.data.teammateName).toBe('worker-sc');
    });

    it('emitTeamTaskEvent_OnFailure_WritesSidecarWithFailureReason', async () => {
      // Arrange — make quality checks fail and trip the circuit breaker
      resetQualityRetries('__all__');
      const typecheckError = new Error('Type checking failed');
      (typecheckError as NodeJS.ErrnoException).status = 1;
      (typecheckError as unknown as { stdout: Buffer }).stdout = Buffer.from('');
      (typecheckError as unknown as { stderr: Buffer }).stderr = Buffer.from('type error');

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typecheck')) {
          throw typecheckError;
        }
        return Buffer.from('');
      });

      const state = {
        featureId: 'sidecar-fail-test',
        phase: 'overhaul-delegate',
        tasks: [
          {
            id: 'task-scf-001',
            title: 'Sidecar fail test task',
            status: 'in_progress',
            branch: 'feat/scf',
          },
        ],
        worktrees: {
          'wt-scf-001': {
            branch: 'feat/scf',
            status: 'active',
            taskId: 'task-scf-001',
            path: '/tmp/sidecar-fail-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'sidecar-fail-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-scf',
        cwd: '/tmp/sidecar-fail-worktree',
      };

      // Act — call 3 times to trip the circuit breaker (only then does it emit team.task.failed)
      await handleTeammateGate(input);
      await handleTeammateGate(input);
      await handleTeammateGate(input);

      // Assert — writeHookEvent should be called with team.task.failed
      const failCalls = mockWriteHookEvent.mock.calls.filter(
        (call) => call[2].type === 'team.task.failed',
      );
      expect(failCalls).toHaveLength(1);

      const [, streamId, event] = failCalls[0];
      expect(streamId).toBe('sidecar-fail-test');
      expect(event.type).toBe('team.task.failed');
      expect(event.data.failureReason).toContain('typecheck');
      // On the circuit-breaker path, taskId/featureId are not passed (no completion context),
      // so taskId falls back to anon-{teammateName} — stable for retry dedup
      expect(event.idempotencyKey).toContain(':team.task.failed:anon-');

      // Cleanup circuit breaker state
      resetQualityRetries('__all__');
    });

    it('emitTeamTaskEvent_IdempotencyKey_IncludesTaskIdAndStreamId', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const state = {
        featureId: 'idem-key-test',
        phase: 'overhaul-delegate',
        tasks: [
          {
            id: 'task-ik-42',
            title: 'Idempotency key task',
            status: 'in_progress',
            branch: 'feat/ik',
            startedAt: new Date(Date.now() - 1000).toISOString(),
          },
        ],
        worktrees: {
          'wt-ik-001': {
            branch: 'feat/ik',
            status: 'active',
            taskId: 'task-ik-42',
            path: '/tmp/idem-key-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'idem-key-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-ik',
        cwd: '/tmp/idem-key-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — idempotency key format is {streamId}:{eventType}:{taskId}
      expect(mockWriteHookEvent).toHaveBeenCalled();
      const [, , event] = mockWriteHookEvent.mock.calls[0];
      expect(event.idempotencyKey).toMatch(/^idem-key-test:team\.task\.completed:task-ik-42$/);
    });
  });

  // ─── Task 004: Single-Writer Compliance ─────────────────────────────────────

  describe('single-writer compliance', () => {
    let tempDir: string;
    const originalEnv = process.env.WORKFLOW_STATE_DIR;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-single-writer-test-'));
      process.env.WORKFLOW_STATE_DIR = tempDir;
    });

    afterEach(async () => {
      process.env.WORKFLOW_STATE_DIR = originalEnv;
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it('should emit team.task.completed event on quality pass', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const mockWrite = vi.mocked(writeHookEvent);
      mockWrite.mockClear();
      const state = {
        featureId: 'single-writer-test',
        phase: 'overhaul-delegate',
        tasks: [
          {
            id: 'task-sw-001',
            title: 'Single writer task',
            status: 'in_progress',
            branch: 'feat/sw',
            startedAt: new Date(Date.now() - 5000).toISOString(),
          },
        ],
        worktrees: {
          'wt-sw-001': {
            branch: 'feat/sw',
            status: 'active',
            taskId: 'task-sw-001',
            path: '/tmp/sw-worktree',
          },
        },
        _version: 1,
      };
      await fsp.writeFile(
        path.join(tempDir, 'single-writer-test.state.json'),
        JSON.stringify(state),
      );

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-sw',
        cwd: '/tmp/sw-worktree',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Assert — gate passes
      expect(result.continue).toBe(true);

      // Assert — event was emitted via sidecar writer
      const completedCalls = mockWrite.mock.calls.filter(
        (call) => call[2].type === 'team.task.completed',
      );
      expect(completedCalls).toHaveLength(1);
      expect(completedCalls[0][2].data.taskId).toBe('task-sw-001');
      expect(completedCalls[0][2].data.teammateName).toBe('worker-sw');
    });

    it('should NOT mutate workflow state file on quality pass', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const state = {
        featureId: 'no-mutate-test',
        phase: 'overhaul-delegate',
        tasks: [
          {
            id: 'task-nm-001',
            title: 'No mutate task',
            status: 'in_progress',
            branch: 'feat/nm',
            startedAt: new Date(Date.now() - 3000).toISOString(),
          },
        ],
        worktrees: {
          'wt-nm-001': {
            branch: 'feat/nm',
            status: 'active',
            taskId: 'task-nm-001',
            path: '/tmp/nm-worktree',
          },
        },
        _version: 1,
      };
      const stateFilePath = path.join(tempDir, 'no-mutate-test.state.json');
      await fsp.writeFile(stateFilePath, JSON.stringify(state));

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-nm',
        cwd: '/tmp/nm-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — state file should NOT be modified
      const updatedRaw = await fsp.readFile(stateFilePath, 'utf-8');
      const updatedState = JSON.parse(updatedRaw);
      expect(updatedState.tasks[0].status).toBe('in_progress');
      expect(updatedState.tasks[0].completedAt).toBeUndefined();
      expect(updatedState._version).toBe(1);
    });
  });
});
