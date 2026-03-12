// ─── Assess Refactor Scope ──────────────────────────────────────────────────
//
// Assesses refactoring scope by counting files and modules to recommend
// polish (<=5 files, single module) or overhaul (>5 files or cross-module).
// Port of scripts/assess-refactor-scope.sh to a TypeScript orchestrate handler.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AssessRefactorScopeArgs {
  readonly files?: readonly string[];
  readonly stateFile?: string;
}

interface AssessRefactorScopeResult {
  readonly passed: boolean;
  readonly recommendedTrack: 'polish' | 'overhaul';
  readonly filesCount: number;
  readonly modulesCount: number;
  readonly report: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractModule(filePath: string): string {
  const firstSegment = filePath.split('/')[0];
  return firstSegment ?? filePath;
}

function getUniqueModules(files: readonly string[]): readonly string[] {
  const modules = new Set<string>();
  for (const f of files) {
    modules.add(extractModule(f));
  }
  return [...modules].sort();
}

function readFilesFromState(stateFile: string): readonly string[] | null {
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  const raw = fs.readFileSync(stateFile, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'explore' in parsed &&
    typeof (parsed as Record<string, unknown>).explore === 'object' &&
    (parsed as Record<string, unknown>).explore !== null
  ) {
    const explore = (parsed as { explore: Record<string, unknown> }).explore;
    if (
      'scopeAssessment' in explore &&
      typeof explore.scopeAssessment === 'object' &&
      explore.scopeAssessment !== null
    ) {
      const scope = explore.scopeAssessment as Record<string, unknown>;
      if ('filesAffected' in scope && Array.isArray(scope.filesAffected)) {
        return scope.filesAffected as string[];
      }
    }
  }
  return null;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleAssessRefactorScope(
  args: AssessRefactorScopeArgs,
): Promise<ToolResult> {
  // Resolve file list from args or state file
  let fileList: readonly string[];

  if (args.files && args.files.length > 0) {
    fileList = args.files;
  } else if (args.stateFile) {
    const fromState = readFilesFromState(args.stateFile);
    if (fromState === null) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `State file not found or missing explore.scopeAssessment.filesAffected: ${args.stateFile}`,
        },
      };
    }
    fileList = fromState;
  } else {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Either files or stateFile is required',
      },
    };
  }

  if (fileList.length === 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'No files provided',
      },
    };
  }

  const filesCount = fileList.length;
  const modules = getUniqueModules(fileList);
  const modulesCount = modules.length;

  // Assess scope checks
  const checks: string[] = [];

  const fileCountPassed = filesCount <= 5;
  if (fileCountPassed) {
    checks.push(`- **PASS**: File count within polish limit (${filesCount} <= 5)`);
  } else {
    checks.push(`- **FAIL**: File count exceeds polish limit — ${filesCount} files (max 5)`);
  }

  const singleModulePassed = modulesCount <= 1;
  if (singleModulePassed) {
    checks.push(`- **PASS**: Single module scope (${modules.join(', ')})`);
  } else {
    checks.push(`- **FAIL**: Cross-module span detected — ${modulesCount} modules: ${modules.join(', ')}`);
  }

  // Determine recommendation
  const passed = fileCountPassed && singleModulePassed;
  const recommendedTrack: 'polish' | 'overhaul' = passed ? 'polish' : 'overhaul';

  // Build report
  const reportLines: string[] = [
    '## Scope Assessment Report',
    '',
    `**Files affected:** ${filesCount}`,
    `**Modules:** ${modules.join(', ')}`,
    `**Recommendation:** ${recommendedTrack}`,
    '',
    ...checks,
    '',
    '---',
    '',
  ];

  if (recommendedTrack === 'polish') {
    reportLines.push('**Result: POLISH** — Scope is within polish limits');
  } else {
    reportLines.push('**Result: OVERHAUL** — Scope exceeds polish limits');
  }

  const report = reportLines.join('\n');

  const result: AssessRefactorScopeResult = {
    passed,
    recommendedTrack,
    filesCount,
    modulesCount,
    report,
  };

  return { success: true, data: result };
}
