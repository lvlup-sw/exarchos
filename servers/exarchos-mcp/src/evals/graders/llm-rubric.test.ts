import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmRubricGrader } from './llm-rubric.js';

// Mock promptfoo module
const mockMatchesLlmRubric = vi.fn();

vi.mock('promptfoo', () => ({
  assertions: {
    matchesLlmRubric: (...args: unknown[]) => mockMatchesLlmRubric(...args),
  },
}));

describe('LlmRubricGrader', () => {
  let grader: LlmRubricGrader;

  beforeEach(() => {
    grader = new LlmRubricGrader();
    mockMatchesLlmRubric.mockReset();
  });

  it('LlmRubricGrader_HasCorrectNameAndType', () => {
    expect(grader.name).toBe('llm-rubric');
    expect(grader.type).toBe('llm-rubric');
  });

  it('LlmRubricGrader_PassingRubric_ReturnsPassedWithScore', async () => {
    mockMatchesLlmRubric.mockResolvedValue({
      pass: true,
      score: 0.9,
      reason: 'Good',
    });

    const result = await grader.grade(
      {},
      { text: 'Hello world' },
      {},
      { rubric: 'Does the output contain a greeting?', outputPath: 'text' },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.reason).toBe('Good');
  });

  it('LlmRubricGrader_FailingRubric_ReturnsFailedWithReason', async () => {
    mockMatchesLlmRubric.mockResolvedValue({
      pass: false,
      score: 0.2,
      reason: 'Missing coverage',
    });

    const result = await grader.grade(
      {},
      { text: 'Incomplete output' },
      {},
      { rubric: 'Does the output cover all topics?', outputPath: 'text' },
    );

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.reason).toBe('Missing coverage');
  });

  it('LlmRubricGrader_WithModelConfig_PassesProviderString', async () => {
    mockMatchesLlmRubric.mockResolvedValue({
      pass: true,
      score: 1.0,
      reason: 'Pass',
    });

    await grader.grade(
      {},
      { text: 'test' },
      {},
      {
        rubric: 'Is it valid?',
        outputPath: 'text',
        model: 'claude-sonnet-4-5-20250929',
      },
    );

    expect(mockMatchesLlmRubric).toHaveBeenCalledWith(
      'Is it valid?',
      'test',
      { provider: 'anthropic:messages:claude-sonnet-4-5-20250929' },
    );
  });

  it('LlmRubricGrader_WithOutputPath_ExtractsNestedField', async () => {
    mockMatchesLlmRubric.mockResolvedValue({
      pass: true,
      score: 0.8,
      reason: 'Good structure',
    });

    await grader.grade(
      {},
      { response: { nested: { value: 'deep text' } } },
      {},
      { rubric: 'Check nested', outputPath: 'response.nested.value' },
    );

    expect(mockMatchesLlmRubric).toHaveBeenCalledWith(
      'Check nested',
      'deep text',
      { provider: undefined },
    );
  });

  it('LlmRubricGrader_NoRubricInConfig_ThrowsError', async () => {
    await expect(
      grader.grade({}, { text: 'test' }, {}, {}),
    ).rejects.toThrow('llm-rubric grader requires config.rubric string');
  });

  it('LlmRubricGrader_NullScore_DefaultsBasedOnPass', async () => {
    mockMatchesLlmRubric.mockResolvedValue({
      pass: true,
      score: undefined,
      reason: undefined,
    });

    const result = await grader.grade(
      {},
      { text: 'test' },
      {},
      { rubric: 'Is it valid?', outputPath: 'text' },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.reason).toBe('Passed rubric');
  });
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('LlmRubricGrader (live)', () => {
  it('should grade with real Anthropic API call', async () => {
    const grader = new LlmRubricGrader();
    const result = await grader.grade(
      {},
      { text: 'Hello, world! This is a test.' },
      {},
      { rubric: 'Does the output contain a greeting?', outputPath: 'text' },
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toBeDefined();
  });
});
