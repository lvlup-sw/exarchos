/**
 * Detects changed API files that need a schema sync. The changed files come from a diff file, or
 * from `git diff --name-only` against the base branch.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import { END_OF_OPTIONS, isSafeBaseRef, unsafeBaseRefResult } from '../git-base-ref.js';

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

/** Lists the changed files with a three-dot diff, then a two-ref diff, then a diff of the base against the worktree. */
function getChangedFilesFromGit(
  repoRoot: string,
  baseBranch: string,
): readonly string[] {
  const revisionLists: readonly (readonly string[])[] = [
    [`${baseBranch}...HEAD`],
    [baseBranch, 'HEAD'],
    [baseBranch],
  ];

  for (const revisions of revisionLists) {
    try {
      const args = ['diff', '--name-only', END_OF_OPTIONS, ...revisions];
      const output = execFileSync('git', args, {
        encoding: 'utf-8',
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as string;
      return output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
    }
  }

  throw new Error(`git diff failed for base '${baseBranch}'`);
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

export function handleNeedsSchemaSync(args: NeedsSchemaSyncArgs): ToolResult {
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
    if (!isSafeBaseRef(baseBranch)) {
      return unsafeBaseRefResult('baseBranch', baseBranch);
    }
    try {
      changedFiles = getChangedFilesFromGit(args.repoRoot, baseBranch);
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
