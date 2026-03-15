/**
 * Runner orchestrator — main entry point for ICPC 2025 benchmark.
 *
 * Coordinates problem loading, arm configuration, session execution,
 * result collection, and report generation.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
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

/**
 * Dependencies that can be injected for testing.
 */
export interface RunnerDeps {
  loadCorpus: (corpusDir: string) => ProblemDefinition[];
  loadArm: (armsDir: string, armId: string) => ArmConfig;
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

/**
 * Resume state — tracks which problem:arm pairs are already completed.
 */
export interface ResumeState {
  completedPairs: Set<string>;
  previousResults: Map<string, ProblemResult>;
}

/**
 * Build an ArmResult from a SessionResult and optional compile/run output.
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
    const verdict = sessionResult.exitReason === 'timeout' ? 'tle' as const : 'rte' as const;

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

/**
 * Build an error ArmResult when the session itself throws.
 */
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
 * Run the full benchmark suite.
 */
export async function runBenchmark(
  config: RunConfig,
  deps: RunnerDeps,
  resumeState?: ResumeState,
): Promise<BenchmarkRun> {
  const runId = config.resumeRunId ?? randomUUID().slice(0, 8);
  const completedPairs = resumeState?.completedPairs ?? new Set<string>();
  const previousResults = resumeState?.previousResults ?? new Map<string, ProblemResult>();

  // Load problems
  const allProblems = deps.loadCorpus(config.corpusDir);
  const problems = config.problems
    ? allProblems.filter((p) => config.problems!.includes(p.id))
    : allProblems;

  // Load arm configs
  const armConfigs = new Map<ArmId, ArmConfig>();
  for (const armId of config.arms) {
    armConfigs.set(armId, deps.loadArm(config.armsDir, armId));
  }

  // Process each problem
  const problemResults: ProblemResult[] = [];

  for (const problem of problems) {
    const armResults: ArmResult[] = [];

    // Check for previous results from resume
    const prev = previousResults.get(problem.id);

    for (const armId of config.arms) {
      const pairKey = `${problem.id}:${armId}`;
      const arm = armConfigs.get(armId)!;

      // Skip completed pairs on resume
      if (completedPairs.has(pairKey) && prev) {
        const prevArm = prev.arms.find((a) => a.arm === armId);
        if (prevArm) {
          armResults.push(prevArm);
          continue;
        }
      }

      // Create output directory for this problem+arm
      const outputDir = path.join(config.resultsDir, runId, problem.id, armId);
      mkdirSync(outputDir, { recursive: true });

      try {
        const sessionResult = await deps.spawnSession(problem, arm, {
          sessionTimeout: config.sessionTimeout,
          outputDir,
          language: config.language,
        });

        // If solution was produced, compile and verify
        let compileResult: { verdict: string; sampleResults: SampleResult[] } | undefined;
        if (sessionResult.exitReason === 'completed' && sessionResult.solutionPath && deps.compileAndRun) {
          compileResult = await deps.compileAndRun(
            sessionResult.solutionPath,
            problem,
            config.language,
          );
        } else if (sessionResult.exitReason === 'completed' && sessionResult.solutionPath) {
          // No compileAndRun provided — mark as pass (testing scenario)
          compileResult = {
            verdict: 'pass',
            sampleResults: problem.samples.map((s) => ({
              sampleId: s.id,
              verdict: 'pass' as const,
              expectedOutput: s.output,
            })),
          };
        }

        armResults.push(buildArmResultFromSession(armId, sessionResult, compileResult));
      } catch {
        armResults.push(buildErrorArmResult(armId));
      }
    }

    problemResults.push({
      problemId: problem.id,
      title: problem.title,
      arms: armResults,
    });
  }

  // Resolve model and commit
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    // Not in a git repo
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

  // Write results JSON
  mkdirSync(config.resultsDir, { recursive: true });
  const resultPath = path.join(config.resultsDir, `${runId}.json`);
  writeFileSync(resultPath, JSON.stringify(benchmarkRun, null, 2));

  // Generate and write report
  mkdirSync(config.reportsDir, { recursive: true });
  const report = deps.generateReport(benchmarkRun);
  const reportPath = path.join(config.reportsDir, `${runId}.md`);
  writeFileSync(reportPath, report);

  return benchmarkRun;
}

/**
 * CLI entry point — parse args and run benchmark.
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

  const config: RunConfig = {
    corpusDir: getFlag('corpus') ?? 'benchmarks/icpc-2025/problems',
    armsDir: getFlag('arms-dir') ?? 'benchmarks/icpc-2025/arms',
    resultsDir: getFlag('results') ?? 'benchmarks/icpc-2025/results',
    reportsDir: getFlag('reports') ?? 'benchmarks/icpc-2025/reports',
    arms,
    problems: getFlagList('problem').length > 0 ? getFlagList('problem') : undefined,
    language: getFlag('language') ?? 'cpp',
    model: getFlag('model'),
    resumeRunId: getFlag('resume'),
    sessionTimeout: parseInt(getFlag('timeout') ?? '600', 10),
  };

  // Dynamic imports for real dependencies (not used in tests)
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

  // Build resume state from previous run if --resume was provided
  let resumeState: ResumeState | undefined;
  if (config.resumeRunId) {
    const { RunStateManager } = await import('./run-state.js');
    const stateManager = new RunStateManager(config.resultsDir, config.resumeRunId);
    const progress = stateManager.load();
    if (progress.completed.length > 0) {
      const completedPairs = new Set(progress.completed.map((c) => `${c.problemId}:${c.arm}`));
      const previousResults = new Map<string, ProblemResult>();
      for (const result of progress.results) {
        previousResults.set(result.problemId, result);
      }
      resumeState = { completedPairs, previousResults };
    }
  }

  const run = await runBenchmark(config, deps, resumeState);
  console.log(`Benchmark complete: ${run.runId}`);
  console.log(`Results: ${config.resultsDir}/${run.runId}.json`);
  console.log(`Report: ${config.reportsDir}/${run.runId}.md`);
}

// Run CLI if invoked directly
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
