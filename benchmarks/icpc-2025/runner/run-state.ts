import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmId, ArmResult, ProblemResult } from './types.js';

export interface RunProgress {
  runId: string;
  timestamp: string;
  completed: Array<{ problemId: string; arm: ArmId }>;
  results: ProblemResult[];
}

export class RunStateManager {
  private readonly partialPath: string;
  private readonly finalPath: string;
  private progress: RunProgress | undefined;

  constructor(
    private readonly resultsDir: string,
    private readonly runId: string,
  ) {
    this.partialPath = join(resultsDir, `${runId}.partial.json`);
    this.finalPath = join(resultsDir, `${runId}.json`);
  }

  load(): RunProgress {
    if (existsSync(this.partialPath)) {
      try {
        const raw = readFileSync(this.partialPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        // Basic validation
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'runId' in parsed &&
          'completed' in parsed &&
          'results' in parsed
        ) {
          this.progress = parsed as RunProgress;
          return this.progress;
        }
      } catch {
        // Corrupted file — log warning and start fresh
        console.warn(`Warning: corrupted state file at ${this.partialPath}, starting fresh`);
      }
    }

    this.progress = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      completed: [],
      results: [],
    };
    return this.progress;
  }

  isCompleted(problemId: string, arm: ArmId): boolean {
    if (!this.progress) {
      throw new Error('Must call load() before isCompleted()');
    }
    return this.progress.completed.some(
      (c) => c.problemId === problemId && c.arm === arm,
    );
  }

  recordCompletion(problemId: string, arm: ArmId, result: ArmResult, title?: string): void {
    if (!this.progress) {
      throw new Error('Must call load() before recordCompletion()');
    }

    this.progress.completed.push({ problemId, arm });

    // Find or create the ProblemResult for this problemId
    let problemResult = this.progress.results.find((r) => r.problemId === problemId);
    if (!problemResult) {
      problemResult = { problemId, title: title ?? problemId, arms: [] };
      this.progress.results.push(problemResult);
    }
    problemResult.arms.push(result);

    this.persist();
  }

  getResults(): ProblemResult[] {
    if (!this.progress) {
      throw new Error('Must call load() before getResults()');
    }
    return this.progress.results;
  }

  finalize(): string {
    if (!existsSync(this.resultsDir)) {
      mkdirSync(this.resultsDir, { recursive: true });
    }
    renameSync(this.partialPath, this.finalPath);
    return this.finalPath;
  }

  private persist(): void {
    if (!existsSync(this.resultsDir)) {
      mkdirSync(this.resultsDir, { recursive: true });
    }
    writeFileSync(this.partialPath, JSON.stringify(this.progress, null, 2), 'utf-8');
  }
}
