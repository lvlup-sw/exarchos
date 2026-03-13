// ─── Validate PR Stack Handler ──────────────────────────────────────────────
//
// Validates that open GitHub PRs form a proper linear chain (stack).
// Ported from scripts/validate-pr-stack.sh.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ValidatePrStackArgs {
  readonly baseBranch: string;
}

interface PrEntry {
  readonly number: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: string;
}

interface ValidatePrStackResult {
  readonly passed: boolean;
  readonly report: string;
  readonly prCount: number;
  readonly errors: readonly string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPrEntryArray(value: unknown): value is PrEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      'number' in item &&
      typeof (item as Record<string, unknown>).number === 'number' &&
      'baseRefName' in item &&
      typeof (item as Record<string, unknown>).baseRefName === 'string' &&
      'headRefName' in item &&
      typeof (item as Record<string, unknown>).headRefName === 'string',
  );
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleValidatePrStack(args: ValidatePrStackArgs): ToolResult {
  // 1. Validate args
  if (!args.baseBranch) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'baseBranch is required' },
    };
  }

  const { baseBranch } = args;

  // 2. Call gh pr list
  let rawJson: string;
  try {
    rawJson = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,baseRefName,headRefName,state'],
      { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: 'GH_CLI_ERROR',
        message: `gh pr list failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // 3. Parse JSON result
  let prs: PrEntry[];
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!isPrEntryArray(parsed)) {
      return {
        success: false,
        error: { code: 'PARSE_ERROR', message: 'Unexpected JSON shape from gh pr list' },
      };
    }
    prs = parsed;
  } catch {
    return {
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Failed to parse gh pr list JSON output' },
    };
  }

  // No open PRs
  if (prs.length === 0) {
    const result: ValidatePrStackResult = {
      passed: true,
      report: 'No open PRs found -- nothing to validate.',
      prCount: 0,
      errors: [],
    };
    return { success: true, data: result };
  }

  // 4. Run 3 validation checks
  const headBranches = new Set(prs.map((pr) => pr.headRefName));
  const errors: string[] = [];

  // Check 1: Each PR's base must be the stack base or another PR's head
  for (const pr of prs) {
    if (pr.baseRefName === baseBranch) continue;
    if (headBranches.has(pr.baseRefName)) continue;
    errors.push(
      `PR #${pr.number} (${pr.headRefName}): base '${pr.baseRefName}' is not '${baseBranch}' and not a head branch of any other open PR`,
    );
  }

  // Check 2: Exactly one PR should target the base branch (linear chain root)
  const rootCount = prs.filter((pr) => pr.baseRefName === baseBranch).length;
  if (rootCount === 0) {
    errors.push(
      `No PR targets '${baseBranch}' directly -- stack root is missing (cyclic or disconnected)`,
    );
  } else if (rootCount > 1) {
    errors.push(
      `Multiple PRs target '${baseBranch}' directly (found ${rootCount}) -- stack is not a linear chain`,
    );
  }

  // Check 3: No branch should be used as a base by more than one PR (no forks)
  for (const head of headBranches) {
    const depCount = prs.filter((pr) => pr.baseRefName === head).length;
    if (depCount > 1) {
      errors.push(`Branch '${head}' is used as base by ${depCount} PRs -- stack has a fork`);
    }
  }

  // 5. Build markdown report
  const passed = errors.length === 0;
  const lines: string[] = [];

  if (passed) {
    lines.push(`Stack is healthy -- ${prs.length} open PR(s) properly chained on '${baseBranch}'.`);
    lines.push('');
    lines.push('Chain:');
    for (const pr of prs) {
      lines.push(`  #${pr.number}: ${pr.baseRefName} <- ${pr.headRefName}`);
    }
  } else {
    lines.push(`Stack validation failed -- ${errors.length} issue(s) found:`);
    for (const error of errors) {
      lines.push(`  - ${error}`);
    }
    lines.push('');
    lines.push('All open PRs:');
    for (const pr of prs) {
      lines.push(`  #${pr.number}: ${pr.baseRefName} <- ${pr.headRefName}`);
    }
  }

  const result: ValidatePrStackResult = {
    passed,
    report: lines.join('\n'),
    prCount: prs.length,
    errors,
  };

  // 6. Return ToolResult
  return { success: true, data: result };
}
