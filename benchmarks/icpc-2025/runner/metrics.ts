import type { Metrics } from './types.js';

export class MetricsCollector {
  private startTime: number = 0;
  private endTime: number = 0;
  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private iterations: number = 0;

  /** Record start time. */
  start(): void {
    this.startTime = performance.now();
  }

  /** Record end time. */
  stop(): void {
    this.endTime = performance.now();
  }

  /** Accumulate token counts from an API call. */
  recordTokens(input: number, output: number): void {
    this.inputTokens += input;
    this.outputTokens += output;
  }

  /** Increment iteration count. */
  recordIteration(): void {
    this.iterations++;
  }

  /**
   * Count non-empty, non-comment lines of code.
   * Excludes blank lines and lines that are only single-line comments (// style).
   */
  countLoc(solutionCode: string): number {
    const lines = solutionCode.split('\n');
    return lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '') return false;
      if (trimmed.startsWith('//')) return false;
      return true;
    }).length;
  }

  /** Produce final metrics object. */
  toMetrics(solutionCode?: string): Metrics {
    const wallClockMs = this.endTime - this.startTime;
    return {
      totalTokens: this.inputTokens + this.outputTokens,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      wallClockSeconds: wallClockMs / 1000,
      iterationCount: this.iterations,
      linesOfCode: solutionCode ? this.countLoc(solutionCode) : 0,
    };
  }

  /** Estimate tokens from byte length when API counts unavailable. */
  static estimateTokens(bytes: number): number {
    return Math.floor(bytes / 4);
  }
}
