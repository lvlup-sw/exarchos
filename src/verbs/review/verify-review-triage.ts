/**
 * Verifies that review triage ran correctly for a stack of PRs. For each PR in
 * the workflow state, it checks the latest `review.routed` event:
 *
 * 1. The event exists.
 * 2. A PR with `riskScore >= 0.4` routes to CodeRabbit.
 * 3. The PR routes to self-hosted review.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveWorkflowState } from '../resolve-state.js';

interface VerifyReviewTriageArgs {
  /**
   * Optional state-file path. Without it, `prs` come from the event-store
   * projection through `featureId` and `eventStore`.
   */
  readonly stateFile?: string;
  /**
   * Optional `.events.jsonl` path. Without it, the `review.routed` events come
   * from the event store through `featureId` and `eventStore`.
   */
  readonly eventStream?: string;
  readonly featureId?: string;
  readonly eventStore?: EventStore;
}

interface TriageCheck {
  readonly status: 'pass' | 'fail';
  readonly message: string;
}

interface VerifyReviewTriageResult {
  readonly passed: boolean;
  readonly report: string;
  readonly checksPassed: number;
  readonly checksFailed: number;
  readonly checks: readonly TriageCheck[];
}

interface StateFilePr {
  readonly number: number;
}

interface StateFileData {
  readonly prs?: readonly StateFilePr[];
}

interface ReviewRoutedEvent {
  readonly type: string;
  readonly data: {
    readonly pr: number;
    readonly riskScore?: number;
    readonly destination?: string;
  };
}

/** Parse JSONL review events. A line that is not valid JSON is skipped. */
function parseJsonl(content: string): readonly ReviewRoutedEvent[] {
  const events: ReviewRoutedEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ReviewRoutedEvent;
      events.push(parsed);
    } catch {
    }
  }
  return events;
}

function findLatestRoutedEvent(
  events: readonly ReviewRoutedEvent[],
  prNumber: number,
): ReviewRoutedEvent | undefined {
  let latest: ReviewRoutedEvent | undefined;
  for (const event of events) {
    if (event.type === 'review.routed' && event.data.pr === prNumber) {
      latest = event;
    }
  }
  return latest;
}

/**
 * Run the triage checks and return a Markdown report.
 *
 * A state file path that does not resolve returns `FILE_NOT_FOUND`. Other
 * resolver errors return as the resolver gives them.
 */
export async function handleVerifyReviewTriage(
  args: VerifyReviewTriageArgs,
): Promise<ToolResult> {
  if (!args.stateFile && !(args.featureId && args.eventStore)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide stateFile, or featureId + eventStore for fileless resolution',
      },
    };
  }

  if (args.eventStream && !existsSync(args.eventStream)) {
    return {
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: `Event stream not found: ${args.eventStream}` },
    };
  }

  const resolved = await resolveWorkflowState({
    stateFile: args.stateFile,
    featureId: args.featureId,
    eventStore: args.eventStore,
  });
  if ('error' in resolved) {
    if (args.stateFile && !existsSync(args.stateFile)) {
      return {
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: `State file not found: ${args.stateFile}` },
      };
    }
    return resolved.error;
  }

  const stateData = resolved.state as unknown as StateFileData;
  const prs = stateData.prs;
  if (!prs || prs.length === 0) {
    return {
      success: false,
      error: { code: 'NO_PRS', message: 'No PRs found in state' },
    };
  }

  let events: readonly ReviewRoutedEvent[];
  if (args.eventStream) {
    const eventContent = readFileSync(args.eventStream, 'utf-8');
    events = parseJsonl(eventContent);
  } else if (args.featureId && args.eventStore) {
    const storeEvents = await args.eventStore.query(args.featureId);
    events = storeEvents
      .filter((e) => e.type === 'review.routed')
      .map((e) => ({ type: e.type, data: e.data as ReviewRoutedEvent['data'] }));
  } else {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide eventStream, or featureId + eventStore to read review.routed events',
      },
    };
  }

  const checks: TriageCheck[] = [];

  for (const pr of prs) {
    const routedEvent = findLatestRoutedEvent(events, pr.number);

    if (!routedEvent) {
      checks.push({ status: 'fail', message: `PR #${pr.number}: missing review.routed event` });
      continue;
    }

    checks.push({ status: 'pass', message: `PR #${pr.number}: review.routed event exists` });

    const riskScore = routedEvent.data.riskScore ?? 0;
    if (riskScore >= 0.4) {
      const dest = routedEvent.data.destination;
      if (dest === 'coderabbit' || dest === 'both') {
        checks.push({
          status: 'pass',
          message: `PR #${pr.number}: high-risk (score=${riskScore}) sent to CodeRabbit`,
        });
      } else {
        checks.push({
          status: 'fail',
          message: `PR #${pr.number}: high-risk (score=${riskScore}) NOT sent to CodeRabbit`,
        });
      }
    }

    const dest = routedEvent.data.destination;
    if (dest === 'self-hosted' || dest === 'both') {
      checks.push({ status: 'pass', message: `PR #${pr.number}: self-hosted review enabled` });
    } else {
      checks.push({ status: 'fail', message: `PR #${pr.number}: self-hosted review NOT enabled` });
    }
  }

  const checksPassed = checks.filter(c => c.status === 'pass').length;
  const checksFailed = checks.filter(c => c.status === 'fail').length;
  const passed = checksFailed === 0;

  const reportLines = [
    '## Review Triage Verification',
    '',
    '| Status | Check |',
    '|--------|-------|',
    ...checks.map(c => `| ${c.status.toUpperCase()} | ${c.message} |`),
    '',
    `**Passed:** ${checksPassed} | **Failed:** ${checksFailed}`,
  ];

  const result: VerifyReviewTriageResult = {
    passed,
    report: reportLines.join('\n'),
    checksPassed,
    checksFailed,
    checks,
  };

  return { success: true, data: result };
}
