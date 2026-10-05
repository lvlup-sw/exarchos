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

    let matchedRequired: number;
    if (ordered) {
      matchedRequired = longestOrderedSubsequence(outputCalls, requiredCalls);
    } else {
      matchedRequired = countUnorderedMatches(outputCalls, requiredCalls);
    }

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
 * Returns the length of the longest common subsequence of `output` and `required`, by dynamic
 * programming. `dp[i][j]` holds the length for `output[0..i-1]` and `required[0..j-1]`. The table
 * is fully allocated, so the `undefined` guards and `?? 0` only narrow the index-access type.
 */
function longestOrderedSubsequence(
  output: ToolCallEntry[],
  required: ToolCallEntry[]
): number {
  const m = output.length;
  const n = required.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    const row = dp[i];
    const prevRow = dp[i - 1];
    const outI = output[i - 1];
    if (row === undefined || prevRow === undefined || outI === undefined) continue;
    for (let j = 1; j <= n; j++) {
      const reqJ = required[j - 1];
      if (reqJ === undefined) continue;
      if (callMatches(outI, reqJ)) {
        row[j] = (prevRow[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }

  return dp[m]?.[n] ?? 0;
}
