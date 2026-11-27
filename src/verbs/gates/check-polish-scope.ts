/**
 * Checks whether a polish refactor has grown past its scope limits, from the committed diff against a
 * base branch through the constrained Git reader. Four triggers expand the scope:
 *
 * 1. More than 5 modified files.
 * 2. More than 2 top-level directories.
 * 3. An implementation `.ts` file without a sibling `.test.ts` file.
 * 4. A structural file (`index.ts`, `types.ts`, a path with `interface`) in a diff that spans
 *    more than one top-level directory.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '../../format.js';
import { decideRelation, locateObservational, observeHead, resolveObservedBase } from '../../utils/git-observer.js';
import { observationalReader } from '../../utils/git-tree.js';

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

/**
 * The changed file names from the merge base of the base name and the head, through the constrained reader.
 * A decided "no merge base" reads from the base itself. A missing checkout, a refused check, an unresolvable name or an undecided answer gives null.
 */
async function getModifiedFiles(repoRoot: string, baseBranch: string, gitPath: string | undefined): Promise<readonly string[] | null> {
  const observation = await locateObservational(repoRoot, observationalReader(gitPath));
  if (observation.kind !== 'located') return null;
  const { located } = observation;
  try {
    const { head } = await observeHead(located);
    const base = await resolveObservedBase(located, baseBranch);
    const relation = await decideRelation(located, 'merge-base', base, head);
    if (relation.kind === 'unreadable') return null;
    const from = relation.kind === 'related' ? relation.commit : base;
    const output = await located.reads.nameOnly(located.gitDir, located.checkout, from, head);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
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

/**
 * Check the polish scope of the diff of `repoRoot` against `baseBranch`. The diff reads Git through the constrained reader.
 * A non-empty `gitPath` names the Git executable. Without it, the read uses the process-wide Git path. An unreadable diff gives DIFF_FAILED.
 */
export async function handleCheckPolishScope(args: CheckPolishScopeArgs, gitPath?: string): Promise<ToolResult> {
  if (!args.repoRoot) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repoRoot is required' },
    };
  }

  const { repoRoot } = args;
  const baseBranch = args.baseBranch ?? 'main';

  const modifiedFiles = await getModifiedFiles(repoRoot, baseBranch, gitPath);

  if (modifiedFiles === null) {
    return {
      success: false,
      error: {
        code: 'DIFF_FAILED',
        message: `Failed to compute git diff against base branch '${baseBranch}' in ${repoRoot}`,
      },
    };
  }

  const fileCount = modifiedFiles.length;
  const modules = getUniqueModules(modifiedFiles);
  const moduleCount = modules.length;

  const checks: ScopeCheck[] = [];
  const triggers: string[] = [];

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
