/**
 * The mock loader acts as if the opt-in eval package is not installed, and rejects with the install hint.
 * The graders must relay that hint as the grade reason. They must not swallow it or crash with module-not-found.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROMPTFOO_INSTALL_HINT } from './promptfoo-loader.js';

vi.mock('./promptfoo-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./promptfoo-loader.js')>();
  return {
    ...actual,
    loadPromptfooAssertions: vi.fn(() => Promise.reject(new Error(actual.PROMPTFOO_INSTALL_HINT))),
  };
});

import { LlmRubricGrader } from './llm-rubric.js';
import { LlmSimilarityGrader } from './llm-similarity.js';

/** `beforeEach` sets an API key. The grader then does not skip for a missing key, and it tries to load promptfoo. */
describe('llm graders — promptfoo (eval package) not installed', () => {
  const originalApiKey = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = originalApiKey;
    } else {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('LlmRubricGrader_EvalPackageMissing_ReturnsFailedWithActionableHint', async () => {
    const grader = new LlmRubricGrader();
    const result = await grader.grade(
      {},
      { text: 'some output' },
      {},
      { rubric: 'is it valid?', outputPath: 'text' },
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('not installed');
    expect(result.reason).toContain('evals-pkg');
  });

  it('LlmSimilarityGrader_EvalPackageMissing_ReturnsFailedWithActionableHint', async () => {
    const grader = new LlmSimilarityGrader();
    const result = await grader.grade(
      {},
      { text: 'some output' },
      { text: 'expected output' },
      { outputPath: 'text', expectedPath: 'text' },
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('not installed');
    expect(result.reason).toContain('evals-pkg');
  });

  it('InstallHint_IsSurfacedVerbatimInGraderReason', async () => {
    const grader = new LlmRubricGrader();
    const result = await grader.grade(
      {},
      { text: 'some output' },
      {},
      { rubric: 'is it valid?', outputPath: 'text' },
    );
    expect(result.reason).toContain(PROMPTFOO_INSTALL_HINT);
  });
});
