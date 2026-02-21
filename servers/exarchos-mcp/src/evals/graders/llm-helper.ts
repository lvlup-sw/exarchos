import type { GradeResult } from '../types.js';

interface LlmAssertionOptions {
  /** Default reason when assertion passes with no reason string */
  passReason?: string;
  /** Default reason when assertion fails with no reason string */
  failReason?: string;
}

/**
 * Shared helper for LLM-based grader assertions.
 * Handles: API key check, error classification, score normalization.
 */
export async function callLlmAssertion(
  fn: (...args: unknown[]) => Promise<{ pass: boolean; score?: number; reason?: string }>,
  args: unknown[],
  details: Record<string, unknown>,
  options?: LlmAssertionOptions,
): Promise<GradeResult> {
  const passReason = options?.passReason ?? 'Passed';
  const failReason = options?.failReason ?? 'Failed';

  // Skip if no API key
  if (!process.env['ANTHROPIC_API_KEY']) {
    return {
      passed: true,
      score: 0,
      reason: 'Skipped: ANTHROPIC_API_KEY not set',
      details: { skipped: true },
    };
  }

  try {
    const result = await fn(...args);
    return {
      passed: result.pass,
      score: result.score ?? (result.pass ? 1.0 : 0.0),
      reason: result.reason ?? (result.pass ? passReason : failReason),
      details,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isApiKeyError = message.includes('API key') || message.includes('apiKey');
    if (isApiKeyError) {
      return {
        passed: true,
        score: 0,
        reason: `Skipped: ${message}`,
        details: { ...details, error: message, skipped: true },
      };
    }
    return {
      passed: false,
      score: 0,
      reason: `LLM grader error: ${message}`,
      details: { ...details, error: message },
    };
  }
}
