/**
 * Assesses refactor scope from the count of files and of top-level modules.
 * It recommends `polish` for at most 5 files in one module, and `overhaul` for a larger scope.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveWorkflowState } from '../resolve-state.js';

export interface AssessRefactorScopeArgs {
  readonly files?: readonly string[];
  readonly stateFile?: string;
  readonly featureId?: string;
  readonly eventStore?: EventStore;
}

interface AssessRefactorScopeResult {
  readonly passed: boolean;
  readonly recommendedTrack: 'polish' | 'overhaul';
  readonly filesCount: number;
  readonly modulesCount: number;
  readonly report: string;
}

/** The module of a path is its first segment, after the function converts backslashes and removes a drive letter or a leading slash. */
function extractModule(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
  const firstSegment = normalized.split('/')[0];
  return firstSegment ?? filePath;
}

function getUniqueModules(files: readonly string[]): readonly string[] {
  const modules = new Set<string>();
  for (const f of files) {
    modules.add(extractModule(f));
  }
  return [...modules].sort();
}

/**
 * Reads `explore.scopeAssessment.filesAffected` from a resolved workflow state, with no disk access.
 * It returns `null` when the field is absent or holds an item that is not a string.
 */
function readFilesFromState(parsed: Record<string, unknown>): readonly string[] | null {
  if (
    'explore' in parsed &&
    typeof parsed.explore === 'object' &&
    parsed.explore !== null
  ) {
    const explore = parsed.explore as Record<string, unknown>;
    if (
      'scopeAssessment' in explore &&
      typeof explore.scopeAssessment === 'object' &&
      explore.scopeAssessment !== null
    ) {
      const scope = explore.scopeAssessment as Record<string, unknown>;
      if (
        'filesAffected' in scope &&
        Array.isArray(scope.filesAffected) &&
        scope.filesAffected.every((item: unknown) => typeof item === 'string')
      ) {
        return scope.filesAffected as string[];
      }
    }
  }
  return null;
}

/**
 * Takes the file list from `files`, or from workflow state through `resolveWorkflowState`.
 * The state path works for a workflow with no `.state.json` file, because the resolver reads the event store.
 */
export async function handleAssessRefactorScope(
  args: AssessRefactorScopeArgs,
): Promise<ToolResult> {
  let fileList: readonly string[];

  if (args.files && args.files.length > 0) {
    fileList = args.files;
  } else if (args.stateFile || (args.featureId && args.eventStore)) {
    const resolved = await resolveWorkflowState({
      stateFile: args.stateFile,
      featureId: args.featureId,
      eventStore: args.eventStore,
    });
    if ('error' in resolved) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `State not found or missing explore.scopeAssessment.filesAffected: ${args.stateFile ?? args.featureId}`,
        },
      };
    }
    const fromState = readFilesFromState(resolved.state);
    if (fromState === null) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `State not found or missing explore.scopeAssessment.filesAffected: ${args.stateFile ?? args.featureId}`,
        },
      };
    }
    fileList = fromState;
  } else {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Either files, stateFile, or featureId + eventStore is required',
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

  const passed = fileCountPassed && singleModulePassed;
  const recommendedTrack: 'polish' | 'overhaul' = passed ? 'polish' : 'overhaul';

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
