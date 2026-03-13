// ─── Validate PR Body ────────────────────────────────────────────────────────
//
// Validates PR body content against required section headers.
// Supports reading from PR number (via gh), file path, or direct body string.
// Ported from scripts/validate-pr-body.sh.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ValidatePrBodyArgs {
  readonly pr?: number;
  readonly bodyFile?: string;
  readonly body?: string;
  readonly template?: string;
}

interface ValidatePrBodyResult {
  readonly passed: boolean;
  readonly missingSections: readonly string[];
  readonly report: string;
  readonly skipped?: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_SECTIONS: readonly string[] = ['Summary', 'Changes', 'Test Plan'];
const SKIP_AUTHORS: readonly string[] = ['renovate[bot]', 'dependabot[bot]'];

// ─── Helpers ───────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionsFromTemplate(templatePath: string): readonly string[] {
  const content = readFileSync(templatePath, 'utf-8');
  const sections: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      sections.push(match[1].trim());
    }
  }
  return sections;
}

interface PrData {
  readonly body: string;
  readonly author: string;
  readonly headRef: string;
}

function fetchPrData(pr: number): PrData {
  const raw = execFileSync(
    'gh',
    ['pr', 'view', String(pr), '--json', 'body,author,headRefName'],
    { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid PR data');
  }
  const obj = parsed as Record<string, unknown>;
  const body = typeof obj['body'] === 'string' ? obj['body'] : '';
  const authorObj = obj['author'];
  const author =
    typeof authorObj === 'object' && authorObj !== null && 'login' in authorObj
      ? String((authorObj as Record<string, unknown>)['login'])
      : '';
  const headRef = typeof obj['headRefName'] === 'string' ? obj['headRefName'] : '';
  return { body, author, headRef };
}

function shouldSkip(author: string, headRef: string): boolean {
  if (SKIP_AUTHORS.includes(author)) return true;
  if (headRef.startsWith('gh-readonly-queue/')) return true;
  return false;
}

function validateSections(
  body: string,
  requiredSections: readonly string[],
): { passed: boolean; missingSections: readonly string[]; report: string } {
  const missing: string[] = [];
  for (const section of requiredSections) {
    const pattern = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'im');
    if (!pattern.test(body)) {
      missing.push(section);
    }
  }

  const reportLines: string[] = [];
  if (missing.length > 0) {
    reportLines.push('PR body validation failed.');
    for (const section of missing) {
      reportLines.push(`  Missing: ## ${section}`);
    }
    reportLines.push('');
    reportLines.push(`Required sections: ${requiredSections.join(', ')}`);
  } else {
    reportLines.push('PR body validation passed.');
  }

  return {
    passed: missing.length === 0,
    missingSections: missing,
    report: reportLines.join('\n'),
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleValidatePrBody(
  args: ValidatePrBodyArgs,
): Promise<ToolResult> {
  let body: string;
  let author = '';
  let headRef = '';

  // Resolve body from input source
  if (args.body !== undefined) {
    body = args.body;
  } else if (args.bodyFile !== undefined) {
    try {
      body = readFileSync(args.bodyFile, 'utf-8');
    } catch {
      return {
        success: false,
        error: { code: 'FILE_ERROR', message: `Failed to read body file: ${args.bodyFile}` },
      };
    }
  } else if (args.pr !== undefined) {
    try {
      const prData = fetchPrData(args.pr);
      body = prData.body;
      author = prData.author;
      headRef = prData.headRef;
    } catch {
      return {
        success: false,
        error: { code: 'GH_ERROR', message: `Failed to fetch PR #${args.pr} via gh` },
      };
    }
  } else {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'No input source provided: specify pr, bodyFile, or body' },
    };
  }

  // Skip conditions
  if (shouldSkip(author, headRef)) {
    const result: ValidatePrBodyResult = {
      passed: true,
      missingSections: [],
      report: 'Skipped: bot author or merge queue PR.',
      skipped: true,
    };
    return { success: true, data: result };
  }

  // Determine required sections
  let requiredSections: readonly string[];
  if (args.template !== undefined) {
    try {
      requiredSections = extractSectionsFromTemplate(args.template);
    } catch {
      return {
        success: false,
        error: { code: 'TEMPLATE_ERROR', message: `Failed to read template: ${args.template}` },
      };
    }
    if (requiredSections.length === 0) {
      return {
        success: false,
        error: { code: 'TEMPLATE_ERROR', message: 'No required sections found in template' },
      };
    }
  } else {
    requiredSections = DEFAULT_SECTIONS;
  }

  // Validate
  const { passed, missingSections, report } = validateSections(body, requiredSections);
  const result: ValidatePrBodyResult = { passed, missingSections, report };

  return { success: true, data: result };
}
