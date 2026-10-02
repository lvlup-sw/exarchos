/**
 * Checks that internal markdown links resolve to existing files.
 * It reads one file from `docFile`, or every `.md` file under `docsDir`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';

interface VerifyDocLinksArgs {
  readonly docFile?: string;
  readonly docsDir?: string;
}

interface BrokenLink {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly resolved: string;
}

interface VerifyDocLinksResult {
  readonly passed: boolean;
  readonly report: string;
  readonly filesChecked: number;
  readonly linksChecked: number;
  readonly linksSkipped: number;
  readonly brokenCount: number;
  readonly brokenLinks: readonly BrokenLink[];
}

/** Recursively collect all .md files under a directory. */
function collectMarkdownFiles(dir: string): readonly string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = toPosix(join(dir, entry));
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath));
    } else if (stat.isFile() && entry.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

const LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Checks every `[text](target)` link in one file and records each broken link.
 * It skips `http://` and `https://` URLs and anchor-only links, and removes a `#section` suffix before the check.
 * A target that starts with `/` is an absolute path. Other targets resolve from the directory of the file.
 * The resolved path is in POSIX form, because `join` gives backslashes on Windows.
 */
function checkFile(
  filePath: string,
  brokenLinks: BrokenLink[],
  counters: { checked: number; skipped: number },
): void {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const fileDir = dirname(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let match: RegExpExecArray | null;
    LINK_REGEX.lastIndex = 0;

    while ((match = LINK_REGEX.exec(line)) !== null) {
      const target = match[2];
      if (target === undefined) continue;

      if (target.startsWith('http://') || target.startsWith('https://')) {
        counters.skipped++;
        continue;
      }

      if (target.startsWith('#')) {
        counters.skipped++;
        continue;
      }

      const fileTarget = target.split('#')[0];

      if (!fileTarget) {
        counters.skipped++;
        continue;
      }

      counters.checked++;

      const resolvedPath = fileTarget.startsWith('/')
        ? fileTarget
        : toPosix(join(fileDir, fileTarget));

      if (!existsSync(resolvedPath)) {
        brokenLinks.push({
          file: filePath,
          line: i + 1,
          target,
          resolved: resolvedPath,
        });
      }
    }
  }
}

function buildReport(
  filesChecked: number,
  linksChecked: number,
  linksSkipped: number,
  brokenLinks: readonly BrokenLink[],
): string {
  const lines: string[] = [
    '## Documentation Link Verification Report',
    '',
    `**Files checked:** ${filesChecked}`,
    `**Links checked:** ${linksChecked}`,
    `**Links skipped:** ${linksSkipped} (external URLs, anchors)`,
    `**Broken links:** ${brokenLinks.length}`,
    '',
  ];

  if (brokenLinks.length > 0) {
    lines.push('### Broken Links', '');
    for (const link of brokenLinks) {
      lines.push(`- \`${link.file}:${link.line} -> ${link.target} (resolved: ${link.resolved})\``);
    }
    lines.push('');
  }

  lines.push('---', '');

  if (brokenLinks.length === 0) {
    lines.push('**Result: PASS** — All internal links resolve to existing files');
  } else {
    lines.push(`**Result: FAIL** — ${brokenLinks.length} broken link(s) found`);
  }

  return lines.join('\n');
}

export function handleVerifyDocLinks(args: VerifyDocLinksArgs): ToolResult {
  if (!args.docFile && !args.docsDir) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Either docFile or docsDir is required',
      },
    };
  }

  let filesToCheck: readonly string[];

  if (args.docFile) {
    if (!existsSync(args.docFile) || !statSync(args.docFile).isFile()) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `File not found: ${args.docFile}`,
        },
      };
    }
    filesToCheck = [args.docFile];
  } else {
    const dir = args.docsDir!;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Directory not found: ${dir}`,
        },
      };
    }
    filesToCheck = collectMarkdownFiles(dir);
  }

  const brokenLinks: BrokenLink[] = [];
  const counters = { checked: 0, skipped: 0 };

  for (const file of filesToCheck) {
    checkFile(file, brokenLinks, counters);
  }

  const report = buildReport(
    filesToCheck.length,
    counters.checked,
    counters.skipped,
    brokenLinks,
  );

  const result: VerifyDocLinksResult = {
    passed: brokenLinks.length === 0,
    report,
    filesChecked: filesToCheck.length,
    linksChecked: counters.checked,
    linksSkipped: counters.skipped,
    brokenCount: brokenLinks.length,
    brokenLinks,
  };

  return { success: true, data: result };
}
