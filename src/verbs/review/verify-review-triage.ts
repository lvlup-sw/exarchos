// ─── Verify Review Triage Gate ────────────────────────────────────────────────
//
// Verifies review triage was applied correctly to a stack of PRs by
// cross-referencing the workflow state file and event stream. Checks:
//   1. A review.routed event exists for each PR
//   2. High-risk PRs (riskScore >= 0.4) were sent to CodeRabbit
//   3. Self-hosted review ran for all PRs
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveWorkflowState } from '../resolve-state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyReviewTriageArgs {
  /**
   * Explicit state-file path. OPTIONAL — when omitted (MCP-only workflows),
   * `prs` are read from the event-store-materialized projection via
   * `featureId` + `eventStore`. INV-1: the event store is the source of truth.
   */
  readonly stateFile?: string;
  /**
   * Explicit `.events.jsonl` path. OPTIONAL override — by default the
   * `review.routed` events are queried directly from the event store via
   * `featureId` + `eventStore`, so MCP-only workflows need no JSONL sidecar.
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

export async function handleVerifyReviewTriage(
  args: VerifyReviewTriageArgs,
): Promise<ToolResult> {
  // Validate inputs — need at least one state source (file or featureId+store)
  if (!args.stateFile && !(args.featureId && args.eventStore)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide stateFile, or featureId + eventStore for fileless resolution',
      },
    };
  }

  // Explicit eventStream file path must exist if provided; otherwise the
  // routed events are queried from the event store.
  if (args.eventStream && !existsSync(args.eventStream)) {
    return {
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: `Event stream not found: ${args.eventStream}` },
    };
  }

  // Resolve `prs` via the canonical resolver (file → event-store fallback).
  // INV-1: the event store is the sole source of truth; `.state.json` is a
  // derived stamp that may be absent for MCP-only workflows.
  const resolved = await resolveWorkflowState({
    stateFile: args.stateFile,
    featureId: args.featureId,
    eventStore: args.eventStore,
  });
  if ('error' in resolved) {
    // Preserve the historical FILE_NOT_FOUND taxonomy for the file-based path
    // (explicit stateFile that doesn't resolve); fall through to the resolver
    // error otherwise.
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

  // Load review.routed events. Prefer the explicit `.events.jsonl` override
  // when given; otherwise query the event store (the canonical source). The
  // store already records `review.routed` events (review/tools.ts:60).
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
    // stateFile given but no event source — cannot verify routing.
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide eventStream, or featureId + eventStore to read review.routed events',
      },
    };
  }

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
