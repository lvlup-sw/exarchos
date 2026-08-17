import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROMPTFOO_INSTALL_HINT } from './promptfoo-loader.js';

// Simulate the opt-in eval package NOT being installed: the loader rejects with
// the actionable install hint. The graders must relay that as a clear grade
// reason — NOT swallow it or surface an opaque module-not-found crash (DR-3).
vi.mock('./promptfoo-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./promptfoo-loader.js')>();
  return {
    ...actual,
    loadPromptfooAssertions: vi.fn(() => Promise.reject(new Error(actual.PROMPTFOO_INSTALL_HINT))),
  };
});

import { LlmRubricGrader } from './llm-rubric.js';
import { LlmSimilarityGrader } from './llm-similarity.js';

describe('llm graders — promptfoo (eval package) not installed', () => {
  const originalApiKey = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    // API key must be present so the grader gets past the "skipped: no key"
    // short-circuit and actually attempts to load promptfoo.
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
    // The grader relays the loader's hint text, not a generic substitute.
    expect(result.reason).toContain(PROMPTFOO_INSTALL_HINT);
  });
});
