// ─── Validate PR Body ────────────────────────────────────────────────────────
//
// Validates PR body content against required section headers.
// Supports reading from PR number (via gh), file path, or direct body string.
// Ported from scripts/validate-pr-body.sh.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { WorkflowIntent } from '../../workflow/schemas.js';
import { readIntent, bodyHasIntentMarker, isMeaningfulIntent } from '../tasks/extract-intent.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ValidatePrBodyArgs {
  readonly pr?: number;
  readonly bodyFile?: string;
  readonly body?: string;
  readonly template?: string;
  /**
   * DR-1 (#1593) task 006: when present (with an event store), the handler
   * fail-soft reads `artifacts.intent` and adds an ADVISORY grounding check —
   * does the body reference the intent (its `## Intent` marker, or its summary /
   * surfaces)? Surfaced as `intentGrounded` + an advisory report line. ADVISORY
   * ONLY: it never changes `passed` (the required-sections gate stays the gate).
   * Absent featureId / intent / event store → the grounding fields are omitted
   * (unchanged legacy result).
   */
  readonly featureId?: string;
  /**
   * Turn the required-sections verdict into a REFUSAL instead of a fact on the
   * success carrier.
   *
   * Absent (the default) the handler answers `success: true` with
   * `passed: false` for a deficient body, which is what a caller that only
   * wants the report needs. A composition that runs this check to decide
   * whether a later step may proceed cannot read that field: a runbook step's
   * failure policy sees the envelope, not the payload. Such a caller passes
   * `enforce: true` and gets the verdict where its policy can act on it.
   */
  readonly enforce?: boolean;
}

interface ValidatePrBodyResult {
  readonly passed: boolean;
  readonly missingSections: readonly string[];
  readonly report: string;
  readonly skipped?: boolean;
  /**
   * ADVISORY (DR-1 task 006): whether the body is grounded in `artifacts.intent`.
   * Present only when a meaningful intent was resolved; omitted otherwise. Does
   * NOT affect `passed`.
   */
  readonly intentGrounded?: boolean;
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
    if (match?.[1] !== undefined) {
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

// ─── DR-1 task 006: advisory intent-grounding check ──────────────────────────

/**
 * Whether the PR body references the captured intent. A body is considered
 * grounded when it carries the `## Intent` grounding marker (the deterministic
 * create_pr enrichment) OR independently references the intent's `summary` or
 * any of its `surfaces`. Pure — case-insensitive substring match, never throws.
 */
function isBodyGroundedInIntent(body: string, intent: WorkflowIntent): boolean {
  if (bodyHasIntentMarker(body)) return true;
  const haystack = body.toLowerCase();
  if (intent.summary.trim().length > 0 && haystack.includes(intent.summary.toLowerCase())) {
    return true;
  }
  return intent.surfaces.some(
    (s) => s.trim().length > 0 && haystack.includes(s.toLowerCase()),
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleValidatePrBody(
  args: ValidatePrBodyArgs,
  _stateDir?: string,
  eventStore?: EventStore,
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

  // Validate (required-sections gate — the load-bearing pass/fail)
  const { passed, missingSections, report } = validateSections(body, requiredSections);

  // ─── DR-1 task 006 — ADVISORY intent-grounding check ──────────────────────
  //
  // Fail-soft read `artifacts.intent`; when it is meaningful, surface whether
  // the body references it (`intentGrounded`) plus an advisory report line. This
  // is ADVISORY ONLY — it MUST NOT change `passed` (the required-sections gate
  // stays the gate). When no featureId / event store / meaningful intent is
  // available, the grounding fields are omitted (unchanged legacy result).
  // INV-6: no `workflowType` branch. Never throws out of validation.
  const intent = await readIntent(args.featureId, eventStore);
  if (intent !== undefined && isMeaningfulIntent(intent)) {
    const intentGrounded = isBodyGroundedInIntent(body, intent);
    const advisory = intentGrounded
      ? `Advisory: PR body is grounded in artifacts.intent (${intent.summary}).`
      : `Advisory: PR body does NOT reference artifacts.intent (${intent.summary}). ` +
        'Consider grounding it in the intended change (surfaces/summary).';
    const result: ValidatePrBodyResult = {
      passed,
      missingSections,
      report: `${report}\n${advisory}`,
      intentGrounded,
    };
    return carry(result, args.enforce === true);
  }

  const result: ValidatePrBodyResult = { passed, missingSections, report };
  return carry(result, args.enforce === true);
}

/**
 * Both verdict exits in one place — the advisory-grounded result and the plain
 * one. Under `enforce` a failing section verdict leaves as a refusal
 * carrying the missing sections and the report in its message — the caller that
 * asked for enforcement reads the envelope, and the detail it would have read
 * off the payload is in the text rather than dropped.
 */
function carry(result: ValidatePrBodyResult, enforce: boolean): ToolResult {
  if (enforce && !result.passed) {
    return {
      success: false,
      error: {
        code: 'PR_BODY_INCOMPLETE',
        message:
          `PR body is missing required section(s): ${result.missingSections.join(', ')}. ` +
          result.report,
      },
    };
  }
  return { success: true, data: result };
}
