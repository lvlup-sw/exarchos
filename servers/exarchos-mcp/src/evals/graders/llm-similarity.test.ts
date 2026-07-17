import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmSimilarityGrader } from './llm-similarity.js';

// promptfoo is an opt-in eval-only dependency (DR-3) and is NOT installed in the
// default test closure, so it cannot be mocked by bare specifier. Instead mock
// the loader seam the grader depends on — `loadPromptfooAssertions()` — which is
// exactly where the grader now obtains the promptfoo `assertions` surface.
const mockMatchesSimilarity = vi.fn();

vi.mock('./promptfoo-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./promptfoo-loader.js')>();
  return {
    ...actual,
    loadPromptfooAssertions: vi.fn(async () => ({
      matchesLlmRubric: vi.fn(),
      matchesSimilarity: (...args: unknown[]) => mockMatchesSimilarity(...args),
    })),
  };
});

describe('LlmSimilarityGrader', () => {
  let grader: LlmSimilarityGrader;
  const originalApiKey = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    grader = new LlmSimilarityGrader();
    mockMatchesSimilarity.mockReset();
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = originalApiKey;
    } else {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('LlmSimilarityGrader_HasCorrectNameAndType', () => {
    expect(grader.name).toBe('llm-similarity');
    expect(grader.type).toBe('llm-similarity');
  });

  it('LlmSimilarityGrader_SimilarTexts_ReturnsPassedWithHighScore', async () => {
    mockMatchesSimilarity.mockResolvedValue({
      pass: true,
      score: 0.95,
      reason: 'Texts are highly similar',
    });

    const result = await grader.grade(
      {},
      { text: 'The cat sat on the mat' },
      { text: 'The cat was sitting on the mat' },
      { outputPath: 'text', expectedPath: 'text' },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.95);
    expect(result.reason).toBe('Texts are highly similar');
  });

  it('LlmSimilarityGrader_DissimilarTexts_ReturnsFailed', async () => {
    mockMatchesSimilarity.mockResolvedValue({
      pass: false,
      score: 0.2,
      reason: 'Texts are dissimilar',
    });

    const result = await grader.grade(
      {},
      { text: 'Hello world' },
      { text: 'Completely different content about quantum physics' },
      { outputPath: 'text', expectedPath: 'text' },
    );

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.reason).toBe('Texts are dissimilar');
  });

  it('LlmSimilarityGrader_WithCustomThreshold_UsesConfigThreshold', async () => {
    mockMatchesSimilarity.mockResolvedValue({
      pass: true,
      score: 0.75,
      reason: 'Similar enough',
    });

    await grader.grade(
      {},
      { text: 'output text' },
      { text: 'expected text' },
      { outputPath: 'text', expectedPath: 'text', threshold: 0.6 },
    );

    // matchesSimilarity(expected, output, threshold, inverse?, grading?)
    expect(mockMatchesSimilarity).toHaveBeenCalledWith(
      'expected text',
      'output text',
      0.6,
      false,
      { provider: undefined },
    );
  });

  it('LlmSimilarityGrader_WithOutputPath_ExtractsNestedField', async () => {
    mockMatchesSimilarity.mockResolvedValue({
      pass: true,
      score: 0.9,
      reason: 'Match',
    });

    await grader.grade(
      {},
      { response: { nested: 'deep output' } },
      { text: 'expected' },
      { outputPath: 'response.nested', expectedPath: 'text' },
    );

    expect(mockMatchesSimilarity).toHaveBeenCalledWith(
      'expected',
      'deep output',
      0.8,
      false,
      { provider: undefined },
    );
  });

  it('LlmSimilarityGrader_WithExpectedInConfig_UsesConfigExpected', async () => {
    mockMatchesSimilarity.mockResolvedValue({
      pass: true,
      score: 0.85,
      reason: 'Match',
    });

    await grader.grade(
      {},
      { text: 'output text' },
      {},
      { outputPath: 'text', expected: 'config expected text' },
    );

    expect(mockMatchesSimilarity).toHaveBeenCalledWith(
      'config expected text',
      'output text',
      0.8,
      false,
      { provider: undefined },
    );
  });

  it('LlmSimilarityGrader_NoExpectedInConfig_FallsBackToExpectedParam', async () => {
    mockMatchesSimilarity.mockResolvedValue({
      pass: true,
      score: 0.88,
      reason: 'Match',
    });

    await grader.grade(
      {},
      { text: 'output text' },
      { text: 'param expected text' },
      { outputPath: 'text', expectedPath: 'text' },
    );

    expect(mockMatchesSimilarity).toHaveBeenCalledWith(
      'param expected text',
      'output text',
      0.8,
      false,
      { provider: undefined },
    );
  });

  it('LlmSimilarityGrader_MissingOutputPath_ReturnsSkipped', async () => {
    const result = await grader.grade(
      {},
      { tool_calls: [], trace_events: [] },
      { tasks: ['T1'] },
      { outputPath: 'tasks', expectedPath: 'tasks' },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.reason).toContain('Skipped');
    expect(result.reason).toContain('tasks');
    expect(result.details?.['skipped']).toBe(true);
    expect(mockMatchesSimilarity).not.toHaveBeenCalled();
  });

  it('LlmSimilarityGrader_MissingExpectedPath_ReturnsSkipped', async () => {
    const result = await grader.grade(
      {},
      { tasks: ['T1'] },
      { tool_calls: [] },
      { outputPath: 'tasks', expectedPath: 'tasks' },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.reason).toContain('Skipped');
    expect(result.reason).toContain('tasks');
    expect(result.details?.['skipped']).toBe(true);
    expect(mockMatchesSimilarity).not.toHaveBeenCalled();
  });

  it('LlmSimilarityGrader_NoApiKey_ReturnsSkipped', async () => {
    delete process.env['ANTHROPIC_API_KEY'];

    const result = await grader.grade(
      {},
      { text: 'output text' },
      { text: 'expected text' },
      { outputPath: 'text', expectedPath: 'text' },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.reason).toContain('Skipped');
    expect(result.reason).toContain('ANTHROPIC_API_KEY');
    expect(result.details?.['skipped']).toBe(true);
    expect(mockMatchesSimilarity).not.toHaveBeenCalled();
  });
});
