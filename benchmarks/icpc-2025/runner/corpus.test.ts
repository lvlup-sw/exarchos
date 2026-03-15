import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProblem, loadCorpus } from './corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const problemsDir = resolve(__dirname, '..', 'problems');

describe('loadProblem', () => {
  it('ValidProblemDir_ReturnsProblemDefinition', () => {
    const problem = loadProblem(resolve(problemsDir, 'A-skew-ed-reasoning'));

    expect(problem.id).toBe('A-skew-ed-reasoning');
    expect(problem.title).toBe('A-Skew-ed Reasoning');
    expect(problem.timeLimit).toBe(2);
    expect(problem.statement).toContain('skew heap');
    expect(problem.tags).toEqual(['trees', 'skew-heap', 'permutation']);
    expect(problem.samples).toHaveLength(3);
    expect(problem.samples[0]).toEqual({
      id: 1,
      input: expect.stringContaining('7\n2 3'),
      output: expect.stringContaining('1 3 2 7 5 6 4'),
    });
    expect(problem.samples[1]).toEqual({
      id: 2,
      input: expect.stringContaining('2\n0 2'),
      output: expect.stringContaining('impossible'),
    });
  });

  it('ParsesMetaJson_ExtractsTimeLimit', () => {
    const problemB = loadProblem(resolve(problemsDir, 'B-blackboard-game'));
    expect(problemB.timeLimit).toBe(1);

    const problemC = loadProblem(resolve(problemsDir, 'C-bride-of-pipe-stream'));
    expect(problemC.timeLimit).toBe(12);

    const problemG = loadProblem(resolve(problemsDir, 'G-lava-moat'));
    expect(problemG.timeLimit).toBe(4);
  });

  it('MissingSamples_ThrowsError', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'corpus-test-'));
    writeFileSync(
      resolve(tempDir, 'meta.json'),
      JSON.stringify({ title: 'Test', timeLimit: 1, tags: [] }),
    );
    writeFileSync(resolve(tempDir, 'problem.md'), '# Test');
    mkdirSync(resolve(tempDir, 'samples'));
    // samples dir exists but is empty

    expect(() => loadProblem(tempDir)).toThrow();
  });
});

describe('loadCorpus', () => {
  it('AllTenProblems_ReturnsCompleteSet', () => {
    const corpus = loadCorpus(problemsDir);

    expect(corpus).toHaveLength(10);

    const ids = corpus.map((p) => p.id);
    expect(ids).toEqual([
      'A-skew-ed-reasoning',
      'B-blackboard-game',
      'C-bride-of-pipe-stream',
      'D-buggy-rover',
      'E-delivery-service',
      'F-herding-cats',
      'G-lava-moat',
      'H-score-values',
      'I-slot-machine',
      'J-stacking-cups',
    ]);

    // Each problem should have at least one sample
    for (const problem of corpus) {
      expect(problem.samples.length).toBeGreaterThanOrEqual(1);
      expect(problem.title).toBeTruthy();
      expect(problem.timeLimit).toBeGreaterThan(0);
      expect(problem.statement).toBeTruthy();
    }
  });
});
