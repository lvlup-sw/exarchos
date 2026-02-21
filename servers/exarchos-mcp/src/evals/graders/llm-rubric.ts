import type { GradeResult, IGrader } from '../types.js';
import { extractOutputText } from './output-extractor.js';
import { callLlmAssertion } from './llm-helper.js';

/**
 * LLM-based rubric grader that wraps Promptfoo's matchesLlmRubric assertion.
 * Uses dynamic import to avoid loading promptfoo during normal MCP server operation.
 * Returns a skipped result (passed=true, score=0) when API keys are missing.
 */
export class LlmRubricGrader implements IGrader {
  readonly name = 'llm-rubric';
  readonly type = 'llm-rubric';

  async grade(
    _input: Record<string, unknown>,
    output: Record<string, unknown>,
    _expected: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<GradeResult> {
    const rubric = config?.rubric;
    if (typeof rubric !== 'string') {
      return {
        passed: false,
        score: 0,
        reason: 'Invalid config: llm-rubric grader requires config.rubric string',
        details: { error: 'missing rubric' },
      };
    }

    const model = config?.model as string | undefined;
    const outputText = extractOutputText(output, config?.outputPath as string | undefined);
    const options = { provider: model ? `anthropic:messages:${model}` : undefined };

    return callLlmAssertion(
      async (r: unknown, o: unknown, opts: unknown) => {
        const { assertions } = await import('promptfoo');
        return assertions.matchesLlmRubric(
          r as string,
          o as string,
          opts as Record<string, unknown>,
        );
      },
      [rubric, outputText, options],
      { model, rubric },
      { passReason: 'Passed rubric', failReason: 'Failed rubric' },
    );
  }
}
