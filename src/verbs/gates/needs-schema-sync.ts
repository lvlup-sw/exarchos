/**
 * Detects changed API files that need a schema sync. The changed files come from a diff file, or
 * from the committed diff against the base branch through the constrained Git reader.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import { decideRelation, locateObservational, observeHead, resolveObservedBase } from '../../utils/git-observer.js';
import { observationalReader } from '../../utils/git-tree.js';

interface NeedsSchemaSyncArgs {
  readonly repoRoot: string;
  readonly baseBranch?: string;
  readonly diffFile?: string;
}

interface NeedsSchemaSyncResult {
  readonly syncNeeded: boolean;
  readonly report: string;
  readonly apiFiles: readonly string[];
}

const API_PATTERNS: readonly RegExp[] = [
  /Endpoints\.cs$/,
  /Models\/[^/]*\.cs$/,
  /Requests\/[^/]*\.cs$/,
  /Responses\/[^/]*\.cs$/,
  /Dtos\/[^/]*\.cs$/,
];

function getChangedFilesFromDiff(diffContent: string): readonly string[] {
  const files = new Set<string>();
  for (const line of diffContent.split('\n')) {
    let path: string | undefined;
    if (line.startsWith('+++ b/')) {
      path = line.slice('+++ b/'.length);
    } else if (line.startsWith('--- a/')) {
      path = line.slice('--- a/'.length);
    }
    if (path && path !== '/dev/null') {
      files.add(path);
    }
  }
  return [...files].sort();
}

/**
 * The changed file names from the merge base of the base name and the head, through the constrained reader.
 * A decided "no merge base" reads from the base itself. The read covers exact commits only, so an uncommitted change does not count.
 * A missing checkout, a refused check, an unresolvable name, an undecided answer or a failed read throws.
 */
async function getChangedFilesFromGit(
  repoRoot: string,
  baseBranch: string,
  gitPath: string | undefined,
): Promise<readonly string[]> {
  const failure = new Error(`git diff failed for base '${baseBranch}'`);
  const observation = await locateObservational(repoRoot, observationalReader(gitPath));
  if (observation.kind !== 'located') throw failure;
  const { located } = observation;
  let output: string;
  try {
    const { head } = await observeHead(located);
    const base = await resolveObservedBase(located, baseBranch);
    const relation = await decideRelation(located, 'merge-base', base, head);
    if (relation.kind === 'unreadable') throw failure;
    output = await located.reads.nameOnly(located.gitDir, located.checkout, relation.kind === 'related' ? relation.commit : base, head);
  } catch {
    throw failure;
  }
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function findApiFiles(changedFiles: readonly string[]): readonly string[] {
  const matched: string[] = [];
  for (const file of changedFiles) {
    if (API_PATTERNS.some((pattern) => pattern.test(file))) {
      matched.push(file);
    }
  }
  return matched;
}

function buildReport(apiFiles: readonly string[]): string {
  const lines: string[] = ['## Schema Sync Check', ''];

  if (apiFiles.length === 0) {
    lines.push('**Result: No sync needed** — No API files modified');
  } else {
    lines.push(
      `**Result: Sync needed** — ${apiFiles.length} API file(s) modified:`,
    );
    lines.push('');
    for (const f of apiFiles) {
      lines.push(`- \`${f}\``);
    }
  }

  return lines.join('\n');
}

/**
 * Report the changed API files of a diff file, or of the committed diff against `baseBranch`.
 * A non-empty `gitPath` is the connector Git path. Without it, the read uses the process-wide Git path. An unreadable diff gives GIT_ERROR.
 */
export async function handleNeedsSchemaSync(args: NeedsSchemaSyncArgs, gitPath?: string): Promise<ToolResult> {
  if (!args.repoRoot) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repoRoot is required' },
    };
  }

  const baseBranch = args.baseBranch ?? 'main';

  let changedFiles: readonly string[];

  if (args.diffFile) {
    if (!existsSync(args.diffFile)) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Diff file not found: ${args.diffFile}`,
        },
      };
    }
    const diffContent = readFileSync(args.diffFile, 'utf-8');
    changedFiles = getChangedFilesFromDiff(diffContent);
  } else {
    try {
      changedFiles = await getChangedFilesFromGit(args.repoRoot, baseBranch, gitPath);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'git diff failed';
      return {
        success: false,
        error: { code: 'GIT_ERROR', message },
      };
    }
  }

  const apiFiles = findApiFiles(changedFiles);
  const report = buildReport(apiFiles);

  const result: NeedsSchemaSyncResult = {
    syncNeeded: apiFiles.length > 0,
    report,
    apiFiles,
  };

  return { success: true, data: result };
}
