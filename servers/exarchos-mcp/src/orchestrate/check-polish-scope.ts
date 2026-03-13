// ─── Check Polish Scope ──────────────────────────────────────────────────────
//
// Checks if a polish refactor scope has expanded beyond limits by examining
// git diff against a base branch. Port of scripts/check-polish-scope.sh to a
// TypeScript orchestrate handler.
//
// Triggers:
//   1. File count > 5
//   2. Module boundaries crossed (>2 top-level dirs)
//   3. New test files needed (impl .ts files without .test.ts counterpart)
//   4. Architectural docs needed (structural files across >1 module)
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CheckPolishScopeArgs {
  readonly repoRoot: string;
  readonly baseBranch?: string;
}

export interface ScopeCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface CheckPolishScopeResult {
  readonly scopeOk: boolean;
  readonly report: string;
  readonly fileCount: number;
  readonly moduleCount: number;
  readonly checks: readonly ScopeCheck[];
  readonly triggers: readonly string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getModifiedFiles(repoRoot: string, baseBranch: string): readonly string[] {
  let output = '';
  try {
    output = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
  } catch {
    try {
      output = execFileSync('git', ['diff', '--name-only', baseBranch, 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      });
    } catch {
      return [];
    }
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getTopLevelDir(filePath: string): string {
  const firstSegment = filePath.split('/')[0];
  return firstSegment ?? filePath;
}

function getUniqueModules(files: readonly string[]): readonly string[] {
  const modules = new Set<string>();
  for (const f of files) {
    modules.add(getTopLevelDir(f));
  }
  return [...modules].sort();
}

function isImplFile(filePath: string): boolean {
  return filePath.endsWith('.ts') && !filePath.endsWith('.test.ts') && !filePath.endsWith('.d.ts');
}

function isStructuralFile(filePath: string): boolean {
  return (
    filePath.endsWith('index.ts') ||
    filePath.endsWith('types.ts') ||
    filePath.includes('interface')
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────

export function handleCheckPolishScope(args: CheckPolishScopeArgs): ToolResult {
  const { repoRoot } = args;
  const baseBranch = args.baseBranch ?? 'main';

  const modifiedFiles = getModifiedFiles(repoRoot, baseBranch);
  const fileCount = modifiedFiles.length;
  const modules = getUniqueModules(modifiedFiles);
  const moduleCount = modules.length;

  const checks: ScopeCheck[] = [];
  const triggers: string[] = [];

  // ── Trigger 1: File count > 5 ──────────────────────────────────────────

  if (fileCount <= 5) {
    checks.push({ name: 'File count within limit', passed: true, detail: `${fileCount} <= 5` });
  } else {
    checks.push({
      name: 'File count exceeds limit',
      passed: false,
      detail: `${fileCount} files modified (max 5)`,
    });
    triggers.push(`File count (${fileCount}) exceeds limit of 5`);
  }

  // ── Trigger 2: Module boundaries crossed (>2 top-level dirs) ──────────

  if (moduleCount <= 2) {
    checks.push({
      name: 'Module boundaries OK',
      passed: true,
      detail: `${moduleCount} top-level dirs`,
    });
  } else {
    checks.push({
      name: 'Module boundaries crossed',
      passed: false,
      detail: `${moduleCount} top-level dirs: ${modules.join(', ')}`,
    });
    triggers.push(`Module boundaries crossed (${moduleCount} dirs: ${modules.join(', ')})`);
  }

  // ── Trigger 3: New test files needed ──────────────────────────────────

  const missingTests: string[] = [];
  for (const f of modifiedFiles) {
    if (isImplFile(f)) {
      const testFile = f.replace(/\.ts$/, '.test.ts');
      if (!existsSync(join(repoRoot, testFile))) {
        missingTests.push(f);
      }
    }
  }

  if (missingTests.length === 0) {
    checks.push({
      name: 'Test coverage OK',
      passed: true,
      detail: 'All impl files have test counterparts',
    });
  } else {
    checks.push({
      name: 'New test files needed',
      passed: false,
      detail: `${missingTests.length} impl files without tests: ${missingTests.join(', ')}`,
    });
    triggers.push(`New test files needed for ${missingTests.length} files`);
  }

  // ── Trigger 4: Architectural docs needed ──────────────────────────────

  let needsArchDocs = false;
  if (moduleCount > 1) {
    for (const f of modifiedFiles) {
      if (isStructuralFile(f)) {
        needsArchDocs = true;
        break;
      }
    }
  }

  if (!needsArchDocs) {
    checks.push({ name: 'No architectural docs needed', passed: true });
  } else {
    checks.push({
      name: 'Architectural documentation likely needed',
      passed: false,
      detail: 'Structural files modified across modules',
    });
    triggers.push('Architectural documentation needed');
  }

  // ── Build report ──────────────────────────────────────────────────────

  const scopeOk = triggers.length === 0;
  const moduleNames = modules.length > 0 ? modules.join(', ') : 'none';

  const reportLines: string[] = [
    '## Polish Scope Check Report',
    '',
    `**Repository:** \`${repoRoot}\``,
    `**Base branch:** ${baseBranch}`,
    `**Files modified:** ${fileCount}`,
    `**Modules touched:** ${moduleCount} (${moduleNames})`,
    '',
  ];

  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    const detail = check.detail ? ` — ${check.detail}` : '';
    reportLines.push(`- **${status}**: ${check.name}${detail}`);
  }

  reportLines.push('', '---', '');

  if (scopeOk) {
    reportLines.push('**Result: SCOPE OK** — All within polish limits');
  } else {
    reportLines.push('**Result: SCOPE EXPANDED** — Switch to overhaul track');
    reportLines.push('');
    reportLines.push('Triggers fired:');
    for (const trigger of triggers) {
      reportLines.push(`  - ${trigger}`);
    }
  }

  const report = reportLines.join('\n');

  const result: CheckPolishScopeResult = {
    scopeOk,
    report,
    fileCount,
    moduleCount,
    checks,
    triggers,
  };

  return { success: true, data: result };
}
