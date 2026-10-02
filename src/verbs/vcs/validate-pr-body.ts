/**
 * Checks a PR body for its required section headers. The body comes from a
 * string, a file, or a PR number through `gh`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { WorkflowIntent } from '../../workflow/schemas.js';
import { readIntent, bodyHasIntentMarker, isMeaningfulIntent } from '../tasks/extract-intent.js';

export interface ValidatePrBodyArgs {
  readonly pr?: number;
  readonly bodyFile?: string;
  readonly body?: string;
  readonly template?: string;
  /**
   * With an event store, the handler reads `artifacts.intent` and adds an
   * advisory check: does the body refer to the intent? The result gets
   * `intentGrounded` and a report line. The check never changes `passed`.
   */
  readonly featureId?: string;
  /**
   * Makes a failed section check a refusal. Without it, a body with missing
   * sections gets `success: true` and `passed: false`. A runbook failure policy
   * reads the envelope, not the payload, so such a caller sets `enforce: true`.
   */
  readonly enforce?: boolean;
}

interface ValidatePrBodyResult {
  readonly passed: boolean;
  readonly missingSections: readonly string[];
  readonly report: string;
  readonly skipped?: boolean;
  /**
   * An advisory flag: true when the body refers to `artifacts.intent`. It is
   * present only for a meaningful intent, and it does not change `passed`.
   */
  readonly intentGrounded?: boolean;
}

const DEFAULT_SECTIONS: readonly string[] = ['Summary', 'Changes', 'Test Plan'];
const SKIP_AUTHORS: readonly string[] = ['renovate[bot]', 'dependabot[bot]'];

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

/**
 * True when the PR body refers to the captured intent. The body must hold the
 * `## Intent` marker, the intent `summary`, or one of its `surfaces`. The text
 * match ignores case.
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

/**
 * Checks the PR body for the required sections. A bot author or a merge queue
 * branch skips the check. A `template` replaces the default sections with its
 * `##` headers. A meaningful intent adds the advisory grounding line.
 */
export async function handleValidatePrBody(
  args: ValidatePrBodyArgs,
  _stateDir?: string,
  eventStore?: EventStore,
): Promise<ToolResult> {
  let body: string;
  let author = '';
  let headRef = '';

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

  if (shouldSkip(author, headRef)) {
    const result: ValidatePrBodyResult = {
      passed: true,
      missingSections: [],
      report: 'Skipped: bot author or merge queue PR.',
      skipped: true,
    };
    return { success: true, data: result };
  }

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

  const { passed, missingSections, report } = validateSections(body, requiredSections);

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
 * Returns the verdict. Under `enforce`, a failed section check becomes a
 * PR_BODY_INCOMPLETE refusal. Its message holds the missing sections and the
 * report, so the caller keeps the detail.
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
