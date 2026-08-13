import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunStateManager } from './run-state.js';
import type { ArmResult } from './types.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'run-state-test-'));
}

function makeArmResult(arm: 'exarchos' | 'vanilla-plan' | 'hn-manual' = 'exarchos'): ArmResult {
  return {
    arm,
    verdict: 'pass',
    sampleResults: [
      { sampleId: 1, verdict: 'pass', expectedOutput: '42', actualOutput: '42' },
    ],
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      wallClockSeconds: 1.0,
      iterationCount: 1,
      linesOfCode: 10,
    },
  };
}

describe('RunStateManager', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('RunState_SaveAfterProblem_PersistsToJson', () => {
    tmpDir = makeTmpDir();
    const manager = new RunStateManager(tmpDir, 'run-001');
    manager.load();

    const armResult = makeArmResult('exarchos');
    manager.recordCompletion('problemA', 'exarchos', armResult);

    const partialPath = join(tmpDir, 'run-001.partial.json');
    expect(existsSync(partialPath)).toBe(true);

    const persisted = JSON.parse(readFileSync(partialPath, 'utf-8'));
    expect(persisted.runId).toBe('run-001');
    expect(persisted.completed).toHaveLength(1);
    expect(persisted.completed[0]).toEqual({ problemId: 'problemA', arm: 'exarchos' });
  });

  it('RunState_LoadExisting_SkipsCompletedProblems', () => {
    tmpDir = makeTmpDir();

    // First manager: record a completion
    const manager1 = new RunStateManager(tmpDir, 'run-002');
    manager1.load();
    manager1.recordCompletion('problemA', 'exarchos', makeArmResult('exarchos'));

    // Second manager: load existing state
    const manager2 = new RunStateManager(tmpDir, 'run-002');
    manager2.load();

    expect(manager2.isCompleted('problemA', 'exarchos')).toBe(true);
    expect(manager2.isCompleted('problemA', 'vanilla-plan')).toBe(false);
    expect(manager2.isCompleted('problemB', 'exarchos')).toBe(false);
  });

  it('RunState_CorruptedFile_StartsFromScratch', () => {
    tmpDir = makeTmpDir();

    // Write garbage to the partial file
    const partialPath = join(tmpDir, 'run-003.partial.json');
    writeFileSync(partialPath, '{{not valid json!!!', 'utf-8');

    const manager = new RunStateManager(tmpDir, 'run-003');
    const progress = manager.load();

    expect(progress.runId).toBe('run-003');
    expect(progress.completed).toHaveLength(0);
    expect(progress.results).toHaveLength(0);
  });

  it('RunState_Finalize_RenamesFile', () => {
    tmpDir = makeTmpDir();
    const manager = new RunStateManager(tmpDir, 'run-004');
    manager.load();
    manager.recordCompletion('problemA', 'exarchos', makeArmResult('exarchos'));

    const partialPath = join(tmpDir, 'run-004.partial.json');
    const finalPath = join(tmpDir, 'run-004.json');

    expect(existsSync(partialPath)).toBe(true);
    expect(existsSync(finalPath)).toBe(false);

    const resultPath = manager.finalize();

    expect(resultPath).toBe(finalPath);
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(partialPath)).toBe(false);
  });
});
