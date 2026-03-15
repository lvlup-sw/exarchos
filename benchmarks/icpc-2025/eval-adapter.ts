import type { ArmResult, BenchmarkRun } from './runner/types.js';

export interface EvalResult {
  id: string;
  passed: boolean;
  score: number;
  duration: number;
  metadata: Record<string, unknown>;
}

export function toEvalResult(armResult: ArmResult, problemId: string): EvalResult {
  const samplesPassedCount = armResult.sampleResults.filter(
    (s) => s.verdict === 'pass'
  ).length;
  const totalSamples = armResult.sampleResults.length;
  const score = totalSamples > 0 ? samplesPassedCount / totalSamples : 0;

  return {
    id: `icpc-2025-${problemId}-${armResult.arm}`,
    passed: armResult.verdict === 'pass',
    score,
    duration: armResult.metrics.wallClockSeconds * 1000,
    metadata: {
      arm: armResult.arm,
      verdict: armResult.verdict,
      tokens: armResult.metrics.totalTokens,
      linesOfCode: armResult.metrics.linesOfCode,
    },
  };
}

export function toJsonl(run: BenchmarkRun): string {
  const lines: string[] = [];

  for (const problem of run.problems) {
    for (const armResult of problem.arms) {
      const evalResult = toEvalResult(armResult, problem.problemId);
      lines.push(JSON.stringify(evalResult));
    }
  }

  return lines.join('\n') + '\n';
}
