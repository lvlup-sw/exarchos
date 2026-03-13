// ─── Verify Doc Links Orchestrate Handler ────────────────────────────────────
//
// Checks that internal markdown links resolve to existing files.
// Accepts either a single file (docFile) or a directory (docsDir) for
// recursive checking. Port of scripts/verify-doc-links.sh.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ToolResult } from '../format.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

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

// ─── File Collection ─────────────────────────────────────────────────────────

/** Recursively collect all .md files under a directory. */
function collectMarkdownFiles(dir: string): readonly string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath));
    } else if (stat.isFile() && entry.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ─── Link Extraction & Checking ──────────────────────────────────────────────

const LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

function checkFile(
  filePath: string,
  brokenLinks: BrokenLink[],
  counters: { checked: number; skipped: number },
): void {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const fileDir = dirname(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    // Reset regex state for each line
    LINK_REGEX.lastIndex = 0;

    while ((match = LINK_REGEX.exec(line)) !== null) {
      const target = match[2];

      // Skip external URLs
      if (target.startsWith('http://') || target.startsWith('https://')) {
        counters.skipped++;
        continue;
      }

      // Skip anchor-only links
      if (target.startsWith('#')) {
        counters.skipped++;
        continue;
      }

      // Strip anchor from target (file.md#section → file.md)
      const fileTarget = target.split('#')[0];

      // Skip if empty after stripping anchor
      if (!fileTarget) {
        counters.skipped++;
        continue;
      }

      counters.checked++;

      // Resolve: absolute paths as-is, relative paths from file's directory
      const resolvedPath = fileTarget.startsWith('/')
        ? fileTarget
        : join(fileDir, fileTarget);

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

// ─── Report Builder ──────────────────────────────────────────────────────────

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

// ─── Handler ─────────────────────────────────────────────────────────────────

export function handleVerifyDocLinks(args: VerifyDocLinksArgs): ToolResult {
  // Input validation: need at least one of docFile or docsDir
  if (!args.docFile && !args.docsDir) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Either docFile or docsDir is required',
      },
    };
  }

  // Collect files to check
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

  // Check all files
  const brokenLinks: BrokenLink[] = [];
  const counters = { checked: 0, skipped: 0 };

  for (const file of filesToCheck) {
    checkFile(file, brokenLinks, counters);
  }

  // Build report
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
