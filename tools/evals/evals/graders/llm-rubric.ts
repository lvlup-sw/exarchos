import type { GradeResult, IGrader } from '../types.js';
import { extractOutputText } from './output-extractor.js';
import { callLlmAssertion } from './llm-helper.js';
import { loadPromptfooAssertions } from './promptfoo-loader.js';

/**
 * LLM-based rubric grader that wraps the `matchesLlmRubric` assertion of Promptfoo.
 * It loads promptfoo lazily from the opt-in eval package, so the default MCP-server install does not ship it.
 * It returns a skipped result (passed=true, score=0) when `ANTHROPIC_API_KEY` is not set or `outputPath` matches nothing.
 * Otherwise, a missing package fails the grade, and the reason holds the install hint.
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
    const outputPath = config?.outputPath as string | undefined;
    const outputText = extractOutputText(output, outputPath);
    if (outputText === null) {
      return {
        passed: true,
        score: 0,
        reason: `Skipped: outputPath '${outputPath}' not found in output`,
        details: { skipped: true },
      };
    }
    const options = { provider: model ? `anthropic:messages:${model}` : undefined };

    return callLlmAssertion(
      async (r: unknown, o: unknown, opts: unknown) => {
        const assertions = await loadPromptfooAssertions();
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
