// ─── Verify Review Triage Gate ────────────────────────────────────────────────
//
// Verifies review triage was applied correctly to a stack of PRs by
// cross-referencing the workflow state file and event stream. Checks:
//   1. A review.routed event exists for each PR
//   2. High-risk PRs (riskScore >= 0.4) were sent to CodeRabbit
//   3. Self-hosted review ran for all PRs
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyReviewTriageArgs {
  readonly stateFile: string;
  readonly eventStream: string;
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJsonl(content: string): readonly ReviewRoutedEvent[] {
  const events: ReviewRoutedEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ReviewRoutedEvent;
      events.push(parsed);
    } catch {
      // Skip malformed lines
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

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleVerifyReviewTriage(args: VerifyReviewTriageArgs): ToolResult {
  // Validate inputs
  if (!args.stateFile) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'stateFile is required' },
    };
  }

  if (!args.eventStream) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'eventStream is required' },
    };
  }

  if (!existsSync(args.stateFile)) {
    return {
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: `State file not found: ${args.stateFile}` },
    };
  }

  if (!existsSync(args.eventStream)) {
    return {
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: `Event stream not found: ${args.eventStream}` },
    };
  }

  // Parse state file
  let stateData: StateFileData;
  try {
    stateData = JSON.parse(readFileSync(args.stateFile, 'utf-8')) as StateFileData;
  } catch {
    return {
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Failed to parse state file as JSON' },
    };
  }

  const prs = stateData.prs;
  if (!prs || prs.length === 0) {
    return {
      success: false,
      error: { code: 'NO_PRS', message: 'No PRs found in state file' },
    };
  }

  // Parse event stream
  const eventContent = readFileSync(args.eventStream, 'utf-8');
  const events = parseJsonl(eventContent);

  // Run checks
  const checks: TriageCheck[] = [];

  for (const pr of prs) {
    const routedEvent = findLatestRoutedEvent(events, pr.number);

    // Check 1: review.routed event exists
    if (!routedEvent) {
      checks.push({ status: 'fail', message: `PR #${pr.number}: missing review.routed event` });
      continue;
    }

    checks.push({ status: 'pass', message: `PR #${pr.number}: review.routed event exists` });

    // Check 2: High-risk PRs sent to CodeRabbit
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

    // Check 3: Self-hosted review enabled
    const dest = routedEvent.data.destination;
    if (dest === 'self-hosted' || dest === 'both') {
      checks.push({ status: 'pass', message: `PR #${pr.number}: self-hosted review enabled` });
    } else {
      checks.push({ status: 'fail', message: `PR #${pr.number}: self-hosted review NOT enabled` });
    }
  }

  // Build report
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
