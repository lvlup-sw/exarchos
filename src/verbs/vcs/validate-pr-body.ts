/**
 * Checks a PR body text for its required section headers. The body comes from
 * a string or a file. The handler reads no PR from a provider.
 */

import { extractSectionsFromTemplateText, validateSections } from '../../vcs/pr-observation.js';
import { readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { WorkflowIntent } from '../../workflow/schemas.js';
import { readIntent, bodyHasIntentMarker, isMeaningfulIntent } from '../tasks/extract-intent.js';

export interface ValidatePrBodyArgs {
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
  /**
   * An advisory flag: true when the body refers to `artifacts.intent`. It is
   * present only for a meaningful intent, and it does not change `passed`.
   */
  readonly intentGrounded?: boolean;
}

const DEFAULT_SECTIONS: readonly string[] = ['Summary', 'Changes', 'Test Plan'];

function extractSectionsFromTemplate(templatePath: string): readonly string[] {
  return extractSectionsFromTemplateText(readFileSync(templatePath, 'utf-8'));
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
 * Checks the PR body text for the required sections. A `template` replaces the
 * default sections with its `##` headers. A meaningful intent adds the advisory
 * grounding line.
 */
export async function handleValidatePrBody(
  args: ValidatePrBodyArgs,
  _stateDir?: string,
  eventStore?: EventStore,
): Promise<ToolResult> {
  let body: string;

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
  } else {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'No input source provided: specify bodyFile or body' },
    };
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
