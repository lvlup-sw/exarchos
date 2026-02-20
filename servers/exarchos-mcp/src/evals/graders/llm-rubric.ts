import type { GradeResult, IGrader } from '../types.js';
import { extractOutputText } from './output-extractor.js';

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

    // Skip if no API key available
    if (!process.env['ANTHROPIC_API_KEY']) {
      return {
        passed: true,
        score: 0,
        reason: 'Skipped: ANTHROPIC_API_KEY not set',
        details: { skipped: true },
      };
    }

    const model = config?.model as string | undefined;
    const outputText = extractOutputText(output, config?.outputPath as string | undefined);

    // Dynamic import to avoid loading promptfoo when not needed
    const { assertions } = await import('promptfoo');

    let result: { pass: boolean; score?: number; reason?: string };
    try {
      result = await assertions.matchesLlmRubric(rubric, outputText, {
        provider: model ? `anthropic:messages:${model}` : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isApiKeyError = message.includes('API key') || message.includes('apiKey');
      if (isApiKeyError) {
        return {
          passed: true,
          score: 0,
          reason: `Skipped: ${message}`,
          details: { model, rubric, error: message, skipped: true },
        };
      }
      return {
        passed: false,
        score: 0,
        reason: `LLM grader error: ${message}`,
        details: { model, rubric, error: message },
      };
    }

    return {
      passed: result.pass,
      score: result.score ?? (result.pass ? 1.0 : 0.0),
      reason: result.reason ?? (result.pass ? 'Passed rubric' : 'Failed rubric'),
      details: { model, rubric },
    };
  }
}
