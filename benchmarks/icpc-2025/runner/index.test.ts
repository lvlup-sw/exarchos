import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBenchmark } from './index.js';
import type { RunConfig } from './index.js';
import type { ProblemDefinition, ArmConfig, ArmId, SampleResult } from './types.js';
import type { SessionResult } from './executor.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeProblem(id: string): ProblemDefinition {
  return {
    id,
    title: `Problem ${id}`,
    timeLimit: 2,
    statement: `Solve ${id}`,
    samples: [{ id: 1, input: '1\n', output: '1\n' }],
  };
}

function makeArm(armId: ArmId): ArmConfig {
  return {
    id: armId,
    name: armId,
    description: `Arm ${armId}`,
    promptTemplate: 'Solve: {{PROBLEM_STATEMENT}}',
    mcpEnabled: armId === 'exarchos',
  };
}

function makeSessionResult(overrides?: Partial<SessionResult>): SessionResult {
  return {
    solutionPath: '/tmp/solution.cpp',
    wallClockSeconds: 30,
    iterationCount: 2,
    exitReason: 'completed',
    tokenUsage: { input: 500, output: 300 },
    ...overrides,
  };
}

/**
 * Mock dependencies object to inject into runBenchmark
 */
function createMockDeps(opts: {
  problems?: ProblemDefinition[];
  arms?: Map<string, ArmConfig>;
  sessionResults?: Map<string, SessionResult>;
  defaultSessionResult?: SessionResult;
  sessionError?: Map<string, Error>;
}) {
  const problems = opts.problems ?? [makeProblem('p1')];
  const arms = opts.arms ?? new Map([['vanilla-plan', makeArm('vanilla-plan')]]);
  const defaultResult = opts.defaultSessionResult ?? makeSessionResult();
  const sessionResults = opts.sessionResults ?? new Map();
  const sessionErrors = opts.sessionError ?? new Map();

  return {
    loadCorpus: vi.fn().mockReturnValue(problems),
    loadArm: vi.fn().mockImplementation((_dir: string, armId: string) => {
      return arms.get(armId) ?? makeArm(armId as ArmId);
    }),
    spawnSession: vi.fn().mockImplementation(
      (problem: ProblemDefinition, arm: ArmConfig) => {
        const key = `${problem.id}:${arm.id}`;
        if (sessionErrors.has(key)) {
          return Promise.reject(sessionErrors.get(key));
        }
        return Promise.resolve(sessionResults.get(key) ?? defaultResult);
      }
    ),
    buildPrompt: vi.fn().mockReturnValue('mock prompt'),
    generateReport: vi.fn().mockReturnValue('# Mock Report\n\nResults here.'),
    // Compile/verify stubs
    compileAndRun: vi.fn().mockResolvedValue({
      verdict: 'pass' as const,
      sampleResults: [{ sampleId: 1, verdict: 'pass' as const, expectedOutput: '1\n' }] satisfies SampleResult[],
    }),
  };
}

describe('runner orchestrator', () => {
  let tmpDir: string;
  let resultsDir: string;
  let reportsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'runner-test-'));
    resultsDir = path.join(tmpDir, 'results');
    reportsDir = path.join(tmpDir, 'reports');
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
    return {
      corpusDir: path.join(tmpDir, 'corpus'),
      armsDir: path.join(tmpDir, 'arms'),
      resultsDir,
      reportsDir,
      arms: ['vanilla-plan'],
      language: 'cpp',
      sessionTimeout: 600,
      ...overrides,
    };
  }

  it('runBenchmark_SingleProblemSingleArm_ProducesResult', async () => {
    const deps = createMockDeps({
      problems: [makeProblem('p1')],
      arms: new Map([['vanilla-plan', makeArm('vanilla-plan')]]),
    });

    const config = makeConfig({ arms: ['vanilla-plan'] });
    const run = await runBenchmark(config, deps);

    expect(run.problems).toHaveLength(1);
    expect(run.problems[0].problemId).toBe('p1');
    expect(run.problems[0].title).toBe('Problem p1');
    expect(run.problems[0].arms).toHaveLength(1);
    expect(run.problems[0].arms[0].arm).toBe('vanilla-plan');
    expect(run.language).toBe('cpp');
    expect(run.runId).toBeDefined();
    expect(deps.spawnSession).toHaveBeenCalledOnce();
  });

  it('runBenchmark_ResumePartial_SkipsCompletedPairs', async () => {
    // Pre-populate a completed result for p1:vanilla-plan
    const completedPairs = new Set(['p1:vanilla-plan']);

    const deps = createMockDeps({
      problems: [makeProblem('p1'), makeProblem('p2')],
      arms: new Map([['vanilla-plan', makeArm('vanilla-plan')]]),
    });

    const config = makeConfig({ arms: ['vanilla-plan'] });
    const run = await runBenchmark(config, deps, {
      completedPairs,
      previousResults: new Map([
        ['p1', {
          problemId: 'p1',
          title: 'Problem p1',
          arms: [{
            arm: 'vanilla-plan' as const,
            verdict: 'pass' as const,
            sampleResults: [{ sampleId: 1, verdict: 'pass' as const, expectedOutput: '1\n' }],
            metrics: {
              totalTokens: 800,
              inputTokens: 500,
              outputTokens: 300,
              wallClockSeconds: 30,
              iterationCount: 2,
              linesOfCode: 10,
            },
          }],
        }],
      ]),
    });

    // Should only call spawnSession for p2, not p1
    expect(deps.spawnSession).toHaveBeenCalledOnce();
    const call = deps.spawnSession.mock.calls[0] as [ProblemDefinition, ArmConfig];
    expect(call[0].id).toBe('p2');

    // But result should contain both problems
    expect(run.problems).toHaveLength(2);
  });

  it('runBenchmark_ArmFailure_ContinuesOtherArms', async () => {
    const deps = createMockDeps({
      problems: [makeProblem('p1')],
      arms: new Map([
        ['vanilla-plan', makeArm('vanilla-plan')],
        ['exarchos', makeArm('exarchos')],
      ]),
      sessionError: new Map([['p1:vanilla-plan', new Error('spawn failed')]]),
    });

    const config = makeConfig({ arms: ['vanilla-plan', 'exarchos'] });
    const run = await runBenchmark(config, deps);

    expect(run.problems).toHaveLength(1);
    const armResults = run.problems[0].arms;
    expect(armResults).toHaveLength(2);

    // vanilla-plan should have error verdict
    const vanillaResult = armResults.find((a) => a.arm === 'vanilla-plan');
    expect(vanillaResult).toBeDefined();
    expect(vanillaResult!.verdict).toBe('rte');

    // exarchos should succeed
    const exarchosResult = armResults.find((a) => a.arm === 'exarchos');
    expect(exarchosResult).toBeDefined();
    expect(exarchosResult!.verdict).toBe('pass');
  });

  it('runBenchmark_ProducesReport_WritesToDisk', async () => {
    const deps = createMockDeps({
      problems: [makeProblem('p1')],
    });

    const config = makeConfig({ arms: ['vanilla-plan'] });
    const run = await runBenchmark(config, deps);

    // Report file should exist
    const reportPath = path.join(reportsDir, `${run.runId}.md`);
    expect(fs.existsSync(reportPath)).toBe(true);

    const content = fs.readFileSync(reportPath, 'utf-8');
    expect(content).toContain('Mock Report');

    // Results file should exist
    const resultPath = path.join(resultsDir, `${run.runId}.json`);
    expect(fs.existsSync(resultPath)).toBe(true);

    const resultData = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(resultData.runId).toBe(run.runId);
  });
});
