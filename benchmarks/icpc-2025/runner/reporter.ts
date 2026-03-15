import type { BenchmarkRun, ArmId } from './types.js';

export function generateReport(run: BenchmarkRun): string {
  const sections: string[] = [];

  // Title
  sections.push('# ICPC 2025 World Finals: Agent Workflow Comparison\n');
  sections.push(`Run: ${run.runId} | Model: ${run.model} | Commit: ${run.commit} | Language: ${run.language}\n`);

  // Methodology
  sections.push('## Methodology\n');
  sections.push('This benchmark compares three approaches ("arms") for solving ICPC-style competitive programming problems:\n');
  for (const arm of run.arms) {
    sections.push(`- **${arm.name}** (${arm.id}): ${arm.description}`);
  }
  sections.push('');

  // Collect arm IDs in order
  const armIds = run.arms.map((a) => a.id);

  // Summary table
  sections.push('## Summary\n');
  const header = `| Problem | ${armIds.join(' | ')} |`;
  const separator = `|---------|${armIds.map(() => '---').join('|')}|`;
  sections.push(header);
  sections.push(separator);

  for (const problem of run.problems) {
    const cells = armIds.map((armId) => {
      const armResult = problem.arms.find((a) => a.arm === armId);
      if (!armResult) return '-';
      return `${armResult.verdict} (${armResult.metrics.totalTokens}t)`;
    });
    sections.push(`| ${problem.problemId}: ${problem.title} | ${cells.join(' | ')} |`);
  }
  sections.push('');

  // Aggregate metrics
  sections.push('## Aggregate Metrics\n');

  for (const armId of armIds) {
    const armResults = run.problems
      .map((p) => p.arms.find((a) => a.arm === armId))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);

    const solved = armResults.filter((a) => a.verdict === 'pass').length;
    const total = armResults.length;
    const meanTokens = Math.round(
      armResults.reduce((sum, a) => sum + a.metrics.totalTokens, 0) / armResults.length
    );
    const meanTime = (
      armResults.reduce((sum, a) => sum + a.metrics.wallClockSeconds, 0) / armResults.length
    ).toFixed(1);

    sections.push(`**${armId}**: ${solved}/${total} solved | Mean tokens: ${meanTokens} | Mean time: ${meanTime}s`);
  }
  sections.push('');

  // Per-problem sections
  sections.push('## Per-Problem Results\n');

  for (const problem of run.problems) {
    sections.push(`### ${problem.problemId}: ${problem.title}\n`);
    for (const armResult of problem.arms) {
      sections.push(`**${armResult.arm}**: ${armResult.verdict}`);
      if (armResult.notes) {
        sections.push(`  Notes: ${armResult.notes}`);
      }
      sections.push(`  Tokens: ${armResult.metrics.totalTokens} | Time: ${armResult.metrics.wallClockSeconds}s | LoC: ${armResult.metrics.linesOfCode}`);
    }
    sections.push('');
  }

  // Caveats
  sections.push('## Caveats\n');
  sections.push('- Results are based on **sample test cases only**, not full ICPC judge test suites.');
  sections.push('- LLM outputs are **non-deterministic**; results may vary across runs.');
  sections.push('- Token counts include all conversation turns, including retries and error recovery.');
  sections.push('- Wall clock time depends on API latency and is not a pure measure of model capability.');

  return sections.join('\n');
}
