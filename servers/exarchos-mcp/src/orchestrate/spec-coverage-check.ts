// ─── Spec Coverage Check Handler ────────────────────────────────────────────
//
// Pure TypeScript port of scripts/spec-coverage-check.sh.
// Verifies test coverage for spec compliance by checking plan references
// against on-disk test files and optional vitest execution.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpecCoverageCheckArgs {
  readonly planFile: string;
  readonly repoRoot: string;
  readonly skipRun?: boolean;
}

interface CheckEntry {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly name: string;
  readonly detail?: string;
}

interface SpecCoverageResult {
  readonly passed: boolean;
  readonly totalTests: number;
  readonly found: number;
  readonly missing: readonly string[];
  readonly report: string;
}

// ─── Test File Extraction ───────────────────────────────────────────────────

const TEST_FILE_PATTERN = /\*\*Test file:\*\*\s*`([^`]+)`/;

/**
 * Extract test file paths from plan markdown.
 * Matches lines like: **Test file:** `src/widget.test.ts`
 */
export function extractTestFiles(planContent: string): readonly string[] {
  const files: string[] = [];
  for (const line of planContent.split('\n')) {
    const match = TEST_FILE_PATTERN.exec(line);
    if (match) {
      files.push(match[1]);
    }
  }
  return files;
}

// ─── Report Generation ─────────────────────────────────────────────────────

function generateReport(
  planFile: string,
  repoRoot: string,
  totalTests: number,
  found: number,
  missingList: readonly string[],
  checks: readonly CheckEntry[],
): string {
  const lines: string[] = [];

  lines.push('## Spec Coverage Report');
  lines.push('');
  lines.push(`**Plan file:** \`${planFile}\``);
  lines.push(`**Repo root:** \`${repoRoot}\``);
  lines.push('');
  lines.push('### Coverage Summary');
  lines.push('');
  lines.push(`- Planned test files: ${totalTests}`);
  lines.push(`- Found on disk: ${found}`);
  lines.push(`- Missing: ${totalTests - found}`);
  lines.push('');

  if (missingList.length > 0) {
    lines.push('### Missing Test Files');
    lines.push('');
    for (const f of missingList) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  lines.push('### Check Results');
  lines.push('');
  for (const check of checks) {
    if (check.detail) {
      lines.push(`- **${check.status}**: ${check.name} — ${check.detail}`);
    } else {
      lines.push(`- **${check.status}**: ${check.name}`);
    }
  }

  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const total = passCount + failCount;

  lines.push('');
  lines.push('---');
  lines.push('');

  if (failCount === 0 && totalTests > 0) {
    lines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  return lines.join('\n');
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleSpecCoverageCheck(args: SpecCoverageCheckArgs): ToolResult {
  const { planFile, repoRoot, skipRun = false } = args;

  // Validate inputs
  if (!existsSync(planFile)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: `Plan file not found: ${planFile}` },
    };
  }

  if (!existsSync(repoRoot)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: `Repo root directory not found: ${repoRoot}` },
    };
  }

  // Read plan and extract test files
  const planContent = readFileSync(planFile, 'utf-8') as string;
  const testFiles = extractTestFiles(planContent);

  const checks: CheckEntry[] = [];
  let found = 0;
  const missingList: string[] = [];

  // Check: plan references test files
  if (testFiles.length === 0) {
    checks.push({
      status: 'FAIL',
      name: 'Test files in plan',
      detail: 'No test files referenced in plan document',
    });
  }

  // Check: each test file exists on disk
  for (const testFile of testFiles) {
    const fullPath = join(repoRoot, testFile);
    if (existsSync(fullPath)) {
      checks.push({ status: 'PASS', name: `Test file exists: ${testFile}` });
      found++;
    } else {
      checks.push({
        status: 'FAIL',
        name: `Test file exists: ${testFile}`,
        detail: `Not found at ${fullPath}`,
      });
      missingList.push(testFile);
    }
  }

  // Check: tests pass (unless skipRun)
  if (skipRun) {
    checks.push({ status: 'SKIP', name: 'Test execution (--skip-run)' });
  } else if (testFiles.length > 0 && missingList.length === 0) {
    for (const testFile of testFiles) {
      try {
        execFileSync('npx', ['vitest', 'run', '--root', repoRoot, testFile], {
          stdio: 'pipe',
        });
        checks.push({ status: 'PASS', name: `Test passes: ${testFile}` });
      } catch {
        checks.push({ status: 'FAIL', name: `Test passes: ${testFile}` });
      }
    }
  }

  // Build report
  const report = generateReport(planFile, repoRoot, testFiles.length, found, missingList, checks);

  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const passed = failCount === 0 && testFiles.length > 0;

  const result: SpecCoverageResult = {
    passed,
    totalTests: testFiles.length,
    found,
    missing: missingList,
    report,
  };

  return { success: true, data: result };
}
