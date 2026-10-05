import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSession } from './executor.js';
import type { ProblemDefinition, ArmConfig } from './types.js';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

function makeProblem(overrides?: Partial<ProblemDefinition>): ProblemDefinition {
  return {
    id: 'test-problem',
    title: 'Test Problem',
    timeLimit: 2,
    statement: 'Write hello world',
    samples: [{ id: 1, input: '1', output: '1' }],
    ...overrides,
  };
}

function makeArm(overrides?: Partial<ArmConfig>): ArmConfig {
  return {
    id: 'vanilla-plan',
    name: 'Vanilla Plan',
    description: 'Plan mode only',
    promptTemplate: 'Solve: {{PROBLEM_STATEMENT}}',
    mcpEnabled: false,
    ...overrides,
  };
}

/**
 * Creates a mock ChildProcess-like object for testing.
 */
function createMockProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delay?: number;
}): { process: ReturnType<typeof createEventEmitter>; finish: () => void } {
  const proc = createEventEmitter();
  const stdoutEmitter = createEventEmitter();
  const stderrEmitter = createEventEmitter();

  stdoutEmitter['pipe'] = vi.fn().mockReturnValue(stdoutEmitter);
  stderrEmitter['pipe'] = vi.fn().mockReturnValue(stderrEmitter);

  proc['stdout'] = stdoutEmitter;
  proc['stderr'] = stderrEmitter;
  proc['stdin'] = { write: vi.fn(), end: vi.fn() };
  proc['pid'] = 12345;
  proc['kill'] = vi.fn().mockReturnValue(true);

  const finish = (): void => {
    if (opts.stdout) {
      stdoutEmitter.emit('data', Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      stderrEmitter.emit('data', Buffer.from(opts.stderr));
    }
    proc.emit('close', opts.exitCode ?? 0);
  };

  return { process: proc, finish };
}

/** An `EventEmitter` that also accepts the properties a ChildProcess carries. */
type MockChildProcess = EventEmitter & Record<string, unknown>;

/**
 * Makes the one type assertion of the stand-in. A ChildProcess stand-in needs `stdout`, `stderr`,
 * `stdin`, `pid` and `kill`, and `EventEmitter` declares none of them. Without this assertion,
 * each assignment needs its own.
 */
function createEventEmitter(): MockChildProcess {
  return new EventEmitter() as MockChildProcess;
}

describe('executor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'executor-test-'));
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it('spawnSession_VanillaArm_DisablesMcpInEnvironment', async () => {
    let capturedEnv: Record<string, string> | undefined;
    const mockSpawn = vi.fn().mockImplementation((_cmd: string, _args: string[], options: { env?: Record<string, string> }) => {
      capturedEnv = options.env;
      const { process: proc, finish } = createMockProcess({ exitCode: 0, stdout: '' });
      setTimeout(finish, 10);
      return proc;
    });

    const problem = makeProblem();
    const arm = makeArm({ id: 'vanilla-plan', mcpEnabled: false });

    await spawnSession(problem, arm, {
      sessionTimeout: 10,
      outputDir: tmpDir,
      language: 'cpp',
    }, mockSpawn);

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!['CLAUDE_MCP_SERVERS']).toBe('{}');
  });

  it('spawnSession_ExarchosArm_EnablesMcpServers', async () => {
    let capturedEnv: Record<string, string> | undefined;
    const mockSpawn = vi.fn().mockImplementation((_cmd: string, _args: string[], options: { env?: Record<string, string> }) => {
      capturedEnv = options.env;
      const { process: proc, finish } = createMockProcess({ exitCode: 0, stdout: '' });
      setTimeout(finish, 10);
      return proc;
    });

    const problem = makeProblem();
    const arm = makeArm({ id: 'exarchos', name: 'Exarchos', description: 'Full governance', mcpEnabled: true });

    await spawnSession(problem, arm, {
      sessionTimeout: 10,
      outputDir: tmpDir,
      language: 'cpp',
    }, mockSpawn);

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!['CLAUDE_MCP_SERVERS']).toBeUndefined();
  });

  it('spawnSession_CollectsSolutionFile_ReturnsPath', async () => {
    const solutionPath = path.join(tmpDir, 'solution.cpp');
    fs.writeFileSync(solutionPath, '#include <iostream>\nint main() { return 0; }');

    const mockSpawn = vi.fn().mockImplementation(() => {
      const { process: proc, finish } = createMockProcess({ exitCode: 0, stdout: '' });
      setTimeout(finish, 10);
      return proc;
    });

    const problem = makeProblem();
    const arm = makeArm();

    const result = await spawnSession(problem, arm, {
      sessionTimeout: 10,
      outputDir: tmpDir,
      language: 'cpp',
    }, mockSpawn);

    expect(result.solutionPath).toBe(solutionPath);
    expect(result.exitReason).toBe('completed');
  });

  /** The test creates no solution file. */
  it('spawnSession_ContextExhaustion_ReturnsNoSolution', async () => {
    const mockSpawn = vi.fn().mockImplementation(() => {
      const { process: proc, finish } = createMockProcess({ exitCode: 0, stdout: '' });
      setTimeout(finish, 10);
      return proc;
    });

    const problem = makeProblem();
    const arm = makeArm();

    const result = await spawnSession(problem, arm, {
      sessionTimeout: 10,
      outputDir: tmpDir,
      language: 'cpp',
    }, mockSpawn);

    expect(result.exitReason).toBe('no_solution');
    expect(result.solutionPath).toBeUndefined();
  });

  it('spawnSession_ExtractsTokenUsage_PopulatesMetrics', async () => {
    fs.writeFileSync(path.join(tmpDir, 'solution.cpp'), 'int main() {}');

    const tokenSummary = JSON.stringify({
      input_tokens: 1500,
      output_tokens: 800,
    });

    const mockSpawn = vi.fn().mockImplementation(() => {
      const { process: proc, finish } = createMockProcess({
        exitCode: 0,
        stderr: `\n> Token usage: ${tokenSummary}\n`,
      });
      setTimeout(finish, 10);
      return proc;
    });

    const problem = makeProblem();
    const arm = makeArm();

    const result = await spawnSession(problem, arm, {
      sessionTimeout: 10,
      outputDir: tmpDir,
      language: 'cpp',
    }, mockSpawn);

    expect(result.tokenUsage).toEqual({ input: 1500, output: 800 });
    expect(result.exitReason).toBe('completed');
  });

  /** The mock process closes only when the 1-second session timeout kills it. */
  it('spawnSession_Timeout_ReturnsTimeoutReason', async () => {
    const mockSpawn = vi.fn().mockImplementation(() => {
      const proc = createEventEmitter();
      const stdoutEmitter = createEventEmitter();
      const stderrEmitter = createEventEmitter();
      proc['stdout'] = stdoutEmitter;
      proc['stderr'] = stderrEmitter;
      proc['stdin'] = { write: vi.fn(), end: vi.fn() };
      proc['pid'] = 12345;
      proc['kill'] = vi.fn().mockImplementation(() => {
        proc.emit('close', 137);
        return true;
      });
      return proc;
    });

    const problem = makeProblem();
    const arm = makeArm();

    const result = await spawnSession(problem, arm, {
      sessionTimeout: 1,
      outputDir: tmpDir,
      language: 'cpp',
    }, mockSpawn);

    expect(result.exitReason).toBe('timeout');
  });
});
