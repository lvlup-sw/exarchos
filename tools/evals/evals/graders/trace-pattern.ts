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
 * Counts the patterns that match in order. A pattern with `min` matches when the trace has at least
 * `min` matching events, and order does not apply to it. For the other patterns, a greedy scan
 * counts the longest prefix of the pattern list that occurs in trace order.
 */
function countOrderedMatches(
  trace: TraceEvent[],
  patterns: TracePattern[]
): number {
  const simplePatterns = patterns.filter((p) => p.min === undefined);
  const countPatterns = patterns.filter((p) => p.min !== undefined);

  let countMatched = 0;
  for (const pattern of countPatterns) {
    const matchingEvents = trace.filter((event) =>
      typeMatches(event.type, pattern.type)
    );
    if (matchingEvents.length >= pattern.min!) {
      countMatched++;
    }
  }

  let patIdx = 0;
  for (const event of trace) {
    const pat = simplePatterns[patIdx];
    if (pat !== undefined && typeMatches(event.type, pat.type)) {
      patIdx++;
    }
  }

  return patIdx + countMatched;
}
