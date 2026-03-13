// ─── Check Coverage Thresholds ───────────────────────────────────────────────
//
// Parses Istanbul/Jest coverage-summary.json files, compares line/branch/function
// percentages against thresholds, and produces a markdown report with pass/fail.
//
// TypeScript port of scripts/check-coverage-thresholds.sh — no jq/awk needed.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CheckCoverageThresholdsArgs {
  readonly coverageFile: string;
  readonly lineThreshold?: number;
  readonly branchThreshold?: number;
  readonly functionThreshold?: number;
}

interface CoverageMetrics {
  readonly lines: number;
  readonly branches: number;
  readonly functions: number;
}

interface CheckCoverageThresholdsResult {
  readonly passed: boolean;
  readonly report: string;
  readonly coverage: CoverageMetrics;
}

interface CoverageSummaryTotal {
  readonly lines: { readonly pct: number };
  readonly branches: { readonly pct: number };
  readonly functions: { readonly pct: number };
}

interface CoverageSummary {
  readonly total: CoverageSummaryTotal;
}

// ─── Defaults (match bash script) ────────────────────────────────────────────

const DEFAULT_LINE_THRESHOLD = 80;
const DEFAULT_BRANCH_THRESHOLD = 70;
const DEFAULT_FUNCTION_THRESHOLD = 100;

// ─── Validation ──────────────────────────────────────────────────────────────

function isCoverageSummary(value: unknown): value is CoverageSummary {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['total'] !== 'object' || obj['total'] === null) return false;
  const total = obj['total'] as Record<string, unknown>;
  for (const key of ['lines', 'branches', 'functions']) {
    if (typeof total[key] !== 'object' || total[key] === null) return false;
    const metric = total[key] as Record<string, unknown>;
    if (typeof metric['pct'] !== 'number') return false;
  }
  return true;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function handleCheckCoverageThresholds(
  args: CheckCoverageThresholdsArgs,
): ToolResult {
  const { coverageFile } = args;
  const lineThreshold = args.lineThreshold ?? DEFAULT_LINE_THRESHOLD;
  const branchThreshold = args.branchThreshold ?? DEFAULT_BRANCH_THRESHOLD;
  const functionThreshold = args.functionThreshold ?? DEFAULT_FUNCTION_THRESHOLD;

  // Validate file exists
  if (!existsSync(coverageFile)) {
    return {
      success: false,
      error: {
        code: 'FILE_NOT_FOUND',
        message: `Coverage file not found: ${coverageFile}`,
      },
    };
  }

  // Read and parse JSON
  let parsed: unknown;
  try {
    const raw = readFileSync(coverageFile, 'utf-8');
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: `Invalid JSON in coverage file: ${coverageFile}`,
      },
    };
  }

  // Validate structure
  if (!isCoverageSummary(parsed)) {
    return {
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: `Coverage file missing expected total.{lines,branches,functions}.pct structure`,
      },
    };
  }

  // Extract metrics
  const coverage: CoverageMetrics = {
    lines: parsed.total.lines.pct,
    branches: parsed.total.branches.pct,
    functions: parsed.total.functions.pct,
  };

  // Check thresholds
  const checks: Array<{ metric: string; actual: number; threshold: number; passed: boolean }> = [
    { metric: 'lines', actual: coverage.lines, threshold: lineThreshold, passed: coverage.lines >= lineThreshold },
    { metric: 'branches', actual: coverage.branches, threshold: branchThreshold, passed: coverage.branches >= branchThreshold },
    { metric: 'functions', actual: coverage.functions, threshold: functionThreshold, passed: coverage.functions >= functionThreshold },
  ];

  const allPassed = checks.every((c) => c.passed);
  const passCount = checks.filter((c) => c.passed).length;
  const failCount = checks.filter((c) => !c.passed).length;
  const total = checks.length;

  // Build markdown report
  const lines: string[] = [];
  lines.push('## Coverage Threshold Report');
  lines.push('');
  lines.push(`**Coverage file:** \`${coverageFile}\``);
  lines.push('');
  lines.push('### Thresholds');
  lines.push('');
  lines.push('| Metric | Actual | Threshold | Status |');
  lines.push('|--------|--------|-----------|--------|');
  for (const c of checks) {
    lines.push(`| ${c.metric} | ${c.actual}% | ${c.threshold}% | ${c.passed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('### Check Results');
  lines.push('');
  for (const c of checks) {
    const label = c.passed ? 'PASS' : 'FAIL';
    const op = c.passed ? '>=' : '<';
    lines.push(`- **${label}**: ${c.metric} — ${c.actual}% ${op} ${c.threshold}%`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  if (allPassed) {
    lines.push(`**Result: PASS** (${passCount}/${total} metrics meet thresholds)`);
  } else {
    lines.push(`**Result: FAIL** (${failCount}/${total} metrics below threshold)`);
  }

  const report = lines.join('\n');

  const result: CheckCoverageThresholdsResult = { passed: allPassed, report, coverage };

  return { success: true, data: result };
}
