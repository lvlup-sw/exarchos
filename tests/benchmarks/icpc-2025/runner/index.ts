/**
 * Entry point of the ICPC 2025 benchmark runner.
 * It loads the problems and the arms, runs each session, and writes the results and the report.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type {
  ArmId,
  ArmConfig,
  ArmResult,
  BenchmarkRun,
  Metrics,
  ProblemDefinition,
  ProblemResult,
  SampleResult,
} from './types.js';
import type { SessionResult } from './executor.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

export interface RunConfig {
  corpusDir: string;
  armsDir: string;
  resultsDir: string;
  reportsDir: string;
  arms: ArmId[];
  problems?: string[];
  language: string;
  model?: string;
  resumeRunId?: string;
  sessionTimeout: number;
}

/** The dependencies that a test can replace. */
export interface RunnerDeps {
  loadCorpus: (corpusDir: string) => ProblemDefinition[];
  /** Takes an `ArmId`, not a `string`, because the real `loadArm` accepts nothing wider. */
  loadArm: (armsDir: string, armId: ArmId) => ArmConfig;
  spawnSession: (
    problem: ProblemDefinition,
    arm: ArmConfig,
    config: { sessionTimeout: number; outputDir: string; language: string },
  ) => Promise<SessionResult>;
  buildPrompt: (problem: ProblemDefinition, arm: ArmConfig, language: string) => string;
  generateReport: (run: BenchmarkRun) => string;
  compileAndRun?: (
    solutionPath: string,
    problem: ProblemDefinition,
    language: string,
  ) => Promise<{ verdict: string; sampleResults: SampleResult[] }>;
}

/** The problem and arm pairs that an earlier run completed, with their results. */
export interface ResumeState {
  completedPairs: Set<string>;
  previousResults: Map<string, ProblemResult>;
}

/**
 * Builds an `ArmResult` from a session result and the optional compile output.
 * When the session did not complete or no compile output exists, the exit reason sets the verdict.
 */
function buildArmResultFromSession(
  armId: ArmId,
  sessionResult: SessionResult,
  compileResult?: { verdict: string; sampleResults: SampleResult[] },
): ArmResult {
  const tokenInput = sessionResult.tokenUsage?.input ?? 0;
  const tokenOutput = sessionResult.tokenUsage?.output ?? 0;
  const metrics: Metrics = {
    totalTokens: tokenInput + tokenOutput,
    inputTokens: tokenInput,
    outputTokens: tokenOutput,
    wallClockSeconds: sessionResult.wallClockSeconds,
    iterationCount: sessionResult.iterationCount,
    linesOfCode: 0,
  };

  if (sessionResult.exitReason !== 'completed' || !compileResult) {
    const verdictMap = { timeout: 'tle', no_solution: 'no_solution', error: 'rte' } as const;
    const verdict = verdictMap[sessionResult.exitReason as keyof typeof verdictMap] ?? 'rte' as const;

    return {
      arm: armId,
      verdict,
      sampleResults: [],
      metrics,
      solution: sessionResult.solutionPath,
    };
  }

  return {
    arm: armId,
    verdict: compileResult.verdict as ArmResult['verdict'],
    sampleResults: compileResult.sampleResults,
    metrics,
    solution: sessionResult.solutionPath,
  };
}

/** Builds the `rte` result for a session that throws. */
function buildErrorArmResult(armId: ArmId): ArmResult {
  return {
    arm: armId,
    verdict: 'rte',
    sampleResults: [],
    metrics: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      wallClockSeconds: 0,
      iterationCount: 0,
      linesOfCode: 0,
    },
  };
}

/**
 * Runs each problem against each arm, then writes the results JSON and the report.
 * On resume, a completed pair reuses its previous result.
 * When `deps.compileAndRun` is absent, a completed session with a solution gets the verdict `pass`.
 * When `git rev-parse` fails, the commit is `unknown`.
 */
export async function runBenchmark(
  config: RunConfig,
  deps: RunnerDeps,
  resumeState?: ResumeState,
  onProgress?: (problemId: string, armId: ArmId, result: ArmResult, title: string) => void,
): Promise<BenchmarkRun> {
  const runId = config.resumeRunId ?? randomUUID().slice(0, 8);
  const completedPairs = resumeState?.completedPairs ?? new Set<string>();
  const previousResults = resumeState?.previousResults ?? new Map<string, ProblemResult>();

  const allProblems = deps.loadCorpus(config.corpusDir);
  const problems = config.problems
    ? allProblems.filter((p) => config.problems!.includes(p.id))
    : allProblems;

  const armConfigs = new Map<ArmId, ArmConfig>();
  for (const armId of config.arms) {
    armConfigs.set(armId, deps.loadArm(config.armsDir, armId));
  }

  const problemResults: ProblemResult[] = [];

  for (const problem of problems) {
    const armResults: ArmResult[] = [];

    const prev = previousResults.get(problem.id);

    for (const armId of config.arms) {
      const pairKey = `${problem.id}:${armId}`;
      const arm = armConfigs.get(armId)!;

      if (completedPairs.has(pairKey) && prev) {
        const prevArm = prev.arms.find((a) => a.arm === armId);
        if (prevArm) {
          armResults.push(prevArm);
          continue;
        }
      }

      const outputDir = path.join(config.resultsDir, runId, problem.id, armId);
      mkdirSync(outputDir, { recursive: true });

      try {
        const sessionResult = await deps.spawnSession(problem, arm, {
          sessionTimeout: config.sessionTimeout,
          outputDir,
          language: config.language,
        });

        let compileResult: { verdict: string; sampleResults: SampleResult[] } | undefined;
        if (sessionResult.exitReason === 'completed' && sessionResult.solutionPath && deps.compileAndRun) {
          compileResult = await deps.compileAndRun(
            sessionResult.solutionPath,
            problem,
            config.language,
          );
        } else if (sessionResult.exitReason === 'completed' && sessionResult.solutionPath) {
          compileResult = {
            verdict: 'pass',
            sampleResults: problem.samples.map((s) => ({
              sampleId: s.id,
              verdict: 'pass' as const,
              expectedOutput: s.output,
            })),
          };
        }

        const armResult = buildArmResultFromSession(armId, sessionResult, compileResult);
        armResults.push(armResult);
        onProgress?.(problem.id, armId, armResult, problem.title);
      } catch (err) {
        console.error(`Session failed for ${problem.id}:${armId}:`, err);
        const armResult = buildErrorArmResult(armId);
        armResults.push(armResult);
        onProgress?.(problem.id, armId, armResult, problem.title);
      }
    }

    problemResults.push({
      problemId: problem.id,
      title: problem.title,
      arms: armResults,
    });
  }

  let commit = 'unknown';
  try {
    commit = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'])).trim();
  } catch {
  }

  const armConfigList = Array.from(armConfigs.values());

  const benchmarkRun: BenchmarkRun = {
    runId,
    timestamp: new Date().toISOString(),
    model: config.model ?? 'claude-opus-4-6',
    commit,
    language: config.language,
    arms: armConfigList,
    problems: problemResults,
  };

  mkdirSync(config.resultsDir, { recursive: true });
  const resultPath = path.join(config.resultsDir, `${runId}.json`);
  writeFileSync(resultPath, JSON.stringify(benchmarkRun, null, 2));

  mkdirSync(config.reportsDir, { recursive: true });
  const report = deps.generateReport(benchmarkRun);
  const reportPath = path.join(config.reportsDir, `${runId}.md`);
  writeFileSync(reportPath, report);

  return benchmarkRun;
}

/**
 * Parses the command-line flags and runs the benchmark.
 * A flag that is not given leaves its optional `RunConfig` key absent, as `exactOptionalPropertyTypes` requires.
 * The real dependencies load through dynamic imports, so a test that imports this module does not load them.
 * `config.resumeRunId` gets the run id, so `runBenchmark` and the state manager use the same id.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  function getFlag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  }

  function getFlagList(name: string): string[] {
    const val = getFlag(name);
    return val ? val.split(',') : [];
  }

  const armList = getFlagList('arm');
  const validArms: ArmId[] = ['exarchos', 'vanilla-plan', 'hn-manual'];
  const arms = armList.length > 0
    ? armList.filter((a): a is ArmId => validArms.includes(a as ArmId))
    : validArms;

  const problems = getFlagList('problem');
  const model = getFlag('model');
  const resumeRunId = getFlag('resume');
  const config: RunConfig = {
    corpusDir: getFlag('corpus') ?? 'tests/benchmarks/icpc-2025/problems',
    armsDir: getFlag('arms-dir') ?? 'tests/benchmarks/icpc-2025/arms',
    resultsDir: getFlag('results') ?? 'tests/benchmarks/icpc-2025/results',
    reportsDir: getFlag('reports') ?? 'tests/benchmarks/icpc-2025/reports',
    arms,
    ...(problems.length > 0 ? { problems } : {}),
    language: getFlag('language') ?? 'cpp',
    ...(model === undefined ? {} : { model }),
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
    sessionTimeout: parseInt(getFlag('timeout') ?? '600', 10) || 600,
  };

  const { loadCorpus } = await import('./corpus.js');
  const { loadArm, buildPrompt } = await import('./arms.js');
  const { spawnSession } = await import('./executor.js');
  const { generateReport } = await import('./reporter.js');

  const deps: RunnerDeps = {
    loadCorpus,
    loadArm,
    spawnSession,
    buildPrompt,
    generateReport,
  };

  const { RunStateManager } = await import('./run-state.js');
  const runId = config.resumeRunId ?? randomUUID().slice(0, 8);
  const stateManager = new RunStateManager(config.resultsDir, runId);
  const progress = stateManager.load();

  let resumeState: ResumeState | undefined;
  if (config.resumeRunId && progress.completed.length > 0) {
    const completedPairs = new Set(progress.completed.map((c) => `${c.problemId}:${c.arm}`));
    const previousResults = new Map<string, ProblemResult>();
    for (const result of progress.results) {
      previousResults.set(result.problemId, result);
    }
    resumeState = { completedPairs, previousResults };
  }

  config.resumeRunId = runId;

  const run = await runBenchmark(config, deps, resumeState, (problemId, armId, result, title) => {
    stateManager.recordCompletion(problemId, armId, result, title);
  });
  console.log(`Benchmark complete: ${run.runId}`);
  console.log(`Results: ${config.resultsDir}/${run.runId}.json`);
  console.log(`Report: ${config.reportsDir}/${run.runId}.md`);
}

import { fileURLToPath } from 'node:url';
/** True when Node runs this file directly. */
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
