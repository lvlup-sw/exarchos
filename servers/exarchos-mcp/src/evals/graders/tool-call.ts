import type { GradeResult, IGrader } from '../types.js';

interface ToolCallEntry {
  tool: string;
  action: string;
  args?: Record<string, unknown>;
}

/**
 * Grades tool call presence, order, and forbidden call violations.
 */
export class ToolCallGrader implements IGrader {
  readonly name = 'tool-call';
  readonly type = 'tool-call';

  async grade(
    _input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<GradeResult> {
    const outputCalls = (output.tool_calls ?? []) as ToolCallEntry[];
    const requiredCalls = (expected.tool_calls ?? []) as ToolCallEntry[];
    const forbiddenCalls = (expected.forbidden_calls ?? []) as ToolCallEntry[];
    const ordered = config?.ordered === true;
    const threshold = (config?.threshold as number | undefined) ?? 1.0;

    const totalChecks = requiredCalls.length + forbiddenCalls.length;

    if (totalChecks === 0) {
      return { passed: true, score: 1.0, reason: 'No tool calls to check' };
    }

    // Count matched required calls
    let matchedRequired: number;
    if (ordered) {
      matchedRequired = longestOrderedSubsequence(outputCalls, requiredCalls);
    } else {
      matchedRequired = countUnorderedMatches(outputCalls, requiredCalls);
    }

    // Count forbidden violations
    let forbiddenViolations = 0;
    for (const forbidden of forbiddenCalls) {
      if (outputCalls.some((call) => callMatches(call, forbidden))) {
        forbiddenViolations++;
      }
    }

    const requiredScore =
      requiredCalls.length > 0 ? matchedRequired / requiredCalls.length : 1.0;
    const penalty =
      totalChecks > 0 ? forbiddenViolations / totalChecks : 0;

    const score = Math.max(0, Math.min(1, requiredScore - penalty));
    const passed = score >= threshold;

    const reasons: string[] = [];
    if (matchedRequired < requiredCalls.length) {
      reasons.push(
        `${matchedRequired}/${requiredCalls.length} required calls matched`
      );
    }
    if (forbiddenViolations > 0) {
      reasons.push(`${forbiddenViolations} forbidden call(s) found`);
    }
    const reason =
      reasons.length === 0 ? 'All tool call checks passed' : reasons.join('; ');

    return { passed, score, reason };
  }
}

function callMatches(actual: ToolCallEntry, expected: ToolCallEntry): boolean {
  return actual.tool === expected.tool && actual.action === expected.action;
}

/**
 * Count how many required calls are present in output (unordered).
 * Each output call can only match one required call.
 */
function countUnorderedMatches(
  output: ToolCallEntry[],
  required: ToolCallEntry[]
): number {
  const used = new Set<number>();
  let matched = 0;

  for (const req of required) {
    const idx = output.findIndex(
      (call, i) => !used.has(i) && callMatches(call, req)
    );
    if (idx !== -1) {
      used.add(idx);
      matched++;
    }
  }

  return matched;
}

/**
 * Find length of longest common subsequence where matching preserves order.
 * Uses dynamic programming LCS approach.
 */
function longestOrderedSubsequence(
  output: ToolCallEntry[],
  required: ToolCallEntry[]
): number {
  const m = output.length;
  const n = required.length;
  // dp[i][j] = LCS length of output[0..i-1] and required[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (callMatches(output[i - 1], required[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[m][n];
}
