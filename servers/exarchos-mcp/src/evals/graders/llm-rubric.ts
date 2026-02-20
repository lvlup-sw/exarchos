import type { GradeResult, IGrader } from '../types.js';
import { extractOutputText } from './output-extractor.js';

/**
 * LLM-based rubric grader that wraps Promptfoo's matchesLlmRubric assertion.
 * Uses dynamic import to avoid loading promptfoo during normal MCP server operation.
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
      throw new Error('llm-rubric grader requires config.rubric string');
    }

    const model = config?.model as string | undefined;
    const outputText = extractOutputText(output, config?.outputPath as string | undefined);

    // Dynamic import to avoid loading promptfoo when not needed
    const { assertions } = await import('promptfoo');
    const result = await assertions.matchesLlmRubric(rubric, outputText, {
      provider: model ? `anthropic:messages:${model}` : undefined,
    });

    return {
      passed: result.pass,
      score: result.score ?? (result.pass ? 1.0 : 0.0),
      reason: result.reason ?? (result.pass ? 'Passed rubric' : 'Failed rubric'),
      details: { model, rubric },
    };
  }
}
