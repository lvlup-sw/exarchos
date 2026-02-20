import type { GradeResult, IGrader } from '../types.js';

interface TraceEvent {
  type: string;
  [key: string]: unknown;
}

interface TracePattern {
  type: string;
  min?: number;
}

/**
 * Grades trace events against expected patterns with glob matching and count constraints.
 */
export class TracePatternGrader implements IGrader {
  readonly name = 'trace-pattern';
  readonly type = 'trace-pattern';

  async grade(
    _input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<GradeResult> {
    const trace = (output.trace_events ?? []) as TraceEvent[];
    const patterns = (expected.patterns ?? []) as TracePattern[];
    const ordered = config?.ordered === true;
    const threshold = (config?.threshold as number | undefined) ?? 1.0;

    if (patterns.length === 0) {
      return { passed: true, score: 1.0, reason: 'No patterns to check' };
    }

    let matched: number;
    if (ordered) {
      matched = countOrderedMatches(trace, patterns);
    } else {
      matched = countUnorderedMatches(trace, patterns);
    }

    const score = matched / patterns.length;
    const passed = score >= threshold;

    const reason =
      matched === patterns.length
        ? 'All trace patterns matched'
        : `${matched}/${patterns.length} patterns matched`;

    return { passed, score, reason };
  }
}

/**
 * Check if a trace event type matches a pattern string (with glob support).
 */
function typeMatches(eventType: string, patternType: string): boolean {
  if (patternType === '*') return true;

  if (patternType.endsWith('.*')) {
    const prefix = patternType.slice(0, -2);
    return eventType.startsWith(prefix + '.') || eventType === prefix;
  }

  return eventType === patternType;
}

/**
 * Count patterns matched (unordered) with count constraints.
 */
function countUnorderedMatches(
  trace: TraceEvent[],
  patterns: TracePattern[]
): number {
  let matched = 0;

  for (const pattern of patterns) {
    const matchingEvents = trace.filter((event) =>
      typeMatches(event.type, pattern.type)
    );

    if (pattern.min !== undefined) {
      if (matchingEvents.length >= pattern.min) {
        matched++;
      }
    } else {
      if (matchingEvents.length > 0) {
        matched++;
      }
    }
  }

  return matched;
}

/**
 * Count patterns matched in order (longest ordered subsequence).
 * Uses LCS approach for patterns that appear as a subsequence in trace.
 */
function countOrderedMatches(
  trace: TraceEvent[],
  patterns: TracePattern[]
): number {
  // For ordered matching with simple patterns (no min count),
  // find longest subsequence of patterns appearing in trace order
  const simplePatterns = patterns.filter((p) => p.min === undefined);
  const countPatterns = patterns.filter((p) => p.min !== undefined);

  // Count patterns with min constraints separately (order doesn't apply to counts)
  let countMatched = 0;
  for (const pattern of countPatterns) {
    const matchingEvents = trace.filter((event) =>
      typeMatches(event.type, pattern.type)
    );
    if (matchingEvents.length >= pattern.min!) {
      countMatched++;
    }
  }

  // Greedy ordered subsequence for simple patterns
  let patIdx = 0;
  for (const event of trace) {
    if (
      patIdx < simplePatterns.length &&
      typeMatches(event.type, simplePatterns[patIdx].type)
    ) {
      patIdx++;
    }
  }

  return patIdx + countMatched;
}
