import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

describe('Assess Refactor Scope', () => {
  it('handleAssessRefactorScope_FewFilesSingleModule_RecommendPolish', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      filesCount: number;
      modulesCount: number;
      report: string;
    };
    expect(data.passed).toBe(true);
    expect(data.recommendedTrack).toBe('polish');
    expect(data.filesCount).toBe(3);
    expect(data.modulesCount).toBe(1);
  });

  it('handleAssessRefactorScope_ManyFiles_RecommendOverhaul', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      filesCount: number;
    };
    expect(data.passed).toBe(false);
    expect(data.recommendedTrack).toBe('overhaul');
    expect(data.filesCount).toBe(6);
  });

  it('handleAssessRefactorScope_CrossModule_RecommendOverhaul', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/foo.ts', 'lib/bar.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      modulesCount: number;
    };
    expect(data.passed).toBe(false);
    expect(data.recommendedTrack).toBe('overhaul');
    expect(data.modulesCount).toBe(2);
  });

  it('handleAssessRefactorScope_ReadsFromStateFile', async () => {
    const stateContent = JSON.stringify({
      explore: {
        scopeAssessment: {
          filesAffected: ['src/one.ts', 'src/two.ts'],
        },
      },
    });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(stateContent);

    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      stateFile: '/tmp/test-state.json',
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      filesCount: number;
    };
    expect(data.passed).toBe(true);
    expect(data.recommendedTrack).toBe('polish');
    expect(data.filesCount).toBe(2);
  });

  it('handleAssessRefactorScope_NoFiles_ReturnsError', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_INPUT');
  });

  it('handleAssessRefactorScope_ReportContainsAssessment', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/foo.ts', 'src/bar.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('Scope Assessment');
    expect(data.report).toContain('Files affected');
    expect(data.report).toContain('polish');
  });
});
