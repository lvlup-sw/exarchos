import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecSyncOptions } from 'node:child_process';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { handleTaskGate, handleTeammateGate, runQualityChecks } from './gates.js';
import type { CommandResult } from '../cli.js';

const mockExecSync = vi.mocked(execSync);

describe('Quality Gate Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
