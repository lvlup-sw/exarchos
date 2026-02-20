import type { GradeResult, IGrader } from '../types.js';
import { extractOutputText } from './output-extractor.js';

const DEFAULT_THRESHOLD = 0.8;

/**
 * LLM-based similarity grader that wraps Promptfoo's matchesSimilarity assertion.
 * Uses dynamic import to avoid loading promptfoo during normal MCP server operation.
 */
export class LlmSimilarityGrader implements IGrader {
  readonly name = 'llm-similarity';
  readonly type = 'llm-similarity';

  async grade(
    _input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<GradeResult> {
    const model = config?.model as string | undefined;
    const threshold = (config?.threshold as number | undefined) ?? DEFAULT_THRESHOLD;
    const outputText = extractOutputText(output, config?.outputPath as string | undefined);

    // Resolve expected text: config.expected takes priority, then expected param via expectedPath
    let expectedText: string;
    if (typeof config?.expected === 'string') {
      expectedText = config.expected;
    } else {
      expectedText = extractOutputText(expected, config?.expectedPath as string | undefined);
    }

    // Dynamic import to avoid loading promptfoo when not needed
    const { assertions } = await import('promptfoo');
    const result = await assertions.matchesSimilarity(
      expectedText,
      outputText,
      threshold,
      false,
      { provider: model ? `anthropic:messages:${model}` : undefined },
    );

    return {
      passed: result.pass,
      score: result.score ?? (result.pass ? 1.0 : 0.0),
      reason: result.reason ?? (result.pass ? 'Passed similarity' : 'Failed similarity'),
      details: { model, threshold, expectedText },
    };
  }
}
