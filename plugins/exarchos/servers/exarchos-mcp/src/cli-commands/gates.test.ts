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
import { handleTaskGate, handleTeammateGate, runQualityChecks, findActiveWorkflowState, findUnblockedTasks, resetQualityRetries } from './gates.js';
import type { CommandResult } from '../cli.js';

const mockExecSync = vi.mocked(execSync);

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

      it('should update task status to complete when quality checks pass', async () => {
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

        // Assert — state file was updated
        const updatedRaw = await fsp.readFile(
          path.join(tempDir, 'test-workflow.state.json'),
          'utf-8',
        );
        const updatedState = JSON.parse(updatedRaw);
        expect(updatedState.tasks[0].status).toBe('complete');
        expect(typeof updatedState.tasks[0].completedAt).toBe('string');
        expect(updatedState._version).toBe(2);
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

      it('should not overwrite state when a concurrent write changes _version', async () => {
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

        // Assert — the concurrent writer's state should be preserved, NOT overwritten
        const finalRaw = await fsp.readFile(stateFilePath, 'utf-8');
        const finalState = JSON.parse(finalRaw);
        // The concurrent writer set _version=2 and status='claimed_by_other'
        // updateTaskCompletion should detect the version mismatch and skip the write
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

    async function readEventLines(): Promise<Record<string, unknown>[]> {
      const eventFile = path.join(tempDir, 'event-test-workflow.events.jsonl');
      try {
        const content = await fsp.readFile(eventFile, 'utf-8');
        return content
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    }

    it('should emit team.task.completed event when quality checks pass', async () => {
      // Arrange
      mockExecSync.mockReturnValue(Buffer.from(''));
      const state = createActiveState({ cwdPath: '/tmp/event-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert
      const events = await readEventLines();
      const completedEvents = events.filter((e) => e.type === 'team.task.completed');
      expect(completedEvents).toHaveLength(1);

      const event = completedEvents[0];
      const data = event.data as Record<string, unknown>;
      expect(data.taskId).toBe('task-evt-001');
      expect(data.teammateName).toBe('worker-1');
      expect(typeof data.durationMs).toBe('number');
      expect((data.durationMs as number)).toBeGreaterThan(0);
      expect(data.testsPassed).toBe(true);
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

      const state = createActiveState({ cwdPath: '/tmp/event-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert — no team.task.completed event should be written
      const events = await readEventLines();
      const completedEvents = events.filter((e) => e.type === 'team.task.completed');
      expect(completedEvents).toHaveLength(0);
    });

    it('should not emit event when no matching task for cwd', async () => {
      // Arrange — state has a worktree at a different path
      mockExecSync.mockReturnValue(Buffer.from(''));
      const state = createActiveState({ cwdPath: '/tmp/other-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      const result = await handleTeammateGate(input);

      // Assert — no event written, but gate still passes
      const events = await readEventLines();
      expect(events).toHaveLength(0);
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

      const state = createActiveState({ cwdPath: '/tmp/event-worktree' });
      await writeStateFile(state);

      const input: Record<string, unknown> = {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'worker-1',
        cwd: '/tmp/event-worktree',
      };

      // Act
      await handleTeammateGate(input);

      // Assert
      const events = await readEventLines();
      const completedEvents = events.filter((e) => e.type === 'team.task.completed');
      expect(completedEvents).toHaveLength(1);

      const data = completedEvents[0].data as Record<string, unknown>;
      const filesChanged = data.filesChanged as string[];
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
});
