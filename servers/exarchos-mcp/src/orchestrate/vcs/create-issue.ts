// ─── VCS Action: create_issue ───────────────────────────────────────────────
//
// Creates an issue via the VCS provider abstraction.
//
// Two-event split (Wave B / B3.4 — audit INV-1 MEDIUM):
//   Phase A — emit `issue.create.requested` (durable intent) BEFORE the
//              non-idempotent `gh issue create` side effect fires.
//   Phase B — idempotent check via `<!-- exarchos-op:UUID -->` marker in
//              the issue body; if the issue already exists, recover by
//              emitting `issue.create.executed` without re-creating.
//   Phase C — create the issue with the marker embedded in the body, emit
//              `issue.create.executed` on success.
//
// On crash between Phase A and Phase C: the next invocation performs the
// marker scan and recovers gracefully — no duplicate issue is created.

import { randomUUID } from 'node:crypto';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';
import {
  withStateRetry,
} from '../../workflow/state-retry.js';
import { ConcurrencyError, StorageBusyError } from '../../event-store/index.js';
import { MAX_STATE_RETRIES } from '../../workflow/state-retry.js';

// ─── Idempotency marker ──────────────────────────────────────────────────────

/** HTML comment marker embedded in the issue body. Invisible in rendered view. */
function buildBodyMarker(operationId: string): string {
  return `<!-- exarchos-op:${operationId} -->`;
}

// ─── DI surface for the marker scan ─────────────────────────────────────────

export interface IssueSummary {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

/**
 * Caller-injectable function that queries existing issues for a given
 * operationId marker in the body. Returns an empty array when no match is
 * found, throws on provider failure.
 *
 * This is REQUIRED at the handler boundary — there is no silent default.
 * CodeRabbit #3224631237 on PR #1348 surfaced that a `() => []` default
 * effectively disables the recovery precheck and causes duplicate issues
 * after a Phase-A/Phase-C crash. The composite handler wires the GitHub
 * provider's `searchIssuesByMarker` as the production implementation;
 * tests pass an explicit stub.
 */
export type ListIssuesByMarker = (operationId: string) => Promise<IssueSummary[]>;

// ─── Handler args ─────────────────────────────────────────────────────────────

export interface HandleCreateIssueArgs {
  readonly title: string;
  readonly body: string;
  readonly labels?: string[];
  readonly assignees?: string[];

  /**
   * Stable idempotency key for this invocation. When supplied (recovery /
   * retry scenarios), the handler embeds this exact UUID as the body marker
   * instead of generating a fresh one — ensuring the marker scan succeeds on
   * re-invocation. Normally omitted; the handler generates a UUID.
   */
  readonly operationId?: string;

  /**
   * REQUIRED — DI hook that scans existing issues for the operationId marker.
   * No silent default: the composite handler injects the provider-backed
   * implementation; tests inject an explicit stub. See CodeRabbit
   * #3224631237 for the rationale (silent default → duplicate issues on
   * crash recovery).
   */
  readonly listIssuesByMarker: ListIssuesByMarker;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleCreateIssue(
  args: HandleCreateIssueArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const provider = await createVcsProvider({ config: ctx.projectConfig });

  // ─── Resolve operationId ──────────────────────────────────────────────────
  //
  // Generate at handler entry so every invocation (including retries) uses
  // the same key. When the caller supplies one (recovery scenario), honour it.
  const operationId = args.operationId ?? randomUUID();
  const marker = buildBodyMarker(operationId);

  // The recovery precheck is load-bearing for the two-event split (INV-1).
  // A missing dependency would silently disable the precheck and re-fire
  // the non-idempotent `gh issue create` after a crash → duplicate issue.
  // Surface the gap at the boundary instead of defaulting to a no-op.
  // (CodeRabbit #3224631237 on PR #1348.)
  if (typeof args.listIssuesByMarker !== 'function') {
    return {
      success: false,
      error: {
        code: 'PRECONDITION_FAILED',
        message:
          'handleCreateIssue: listIssuesByMarker dependency is required — ' +
          'the recovery precheck cannot run without it. The composite ' +
          'handler wires VcsProvider.searchIssuesByMarker as the default; ' +
          'callers invoking handleCreateIssue directly must inject one.',
      },
    };
  }
  const listIssuesByMarker = args.listIssuesByMarker;

  // ─── Phase A — durable INTENT (audit INV-1 MEDIUM) ───────────────────────
  //
  // Commit `issue.create.requested` BEFORE the non-idempotent `gh issue create`
  // call fires. If Phase A fails with a transient OCC/busy signal,
  // `withStateRetry` retries the append; the VCS createIssue side effect is
  // OUTSIDE this retry boundary so it never fires more than once.
  try {
    await withStateRetry(() =>
      ctx.eventStore.append('vcs', {
        type: 'issue.create.requested',
        data: {
          operationId,
          title: args.title,
          body: args.body,
          ...(args.labels !== undefined ? { labels: args.labels } : {}),
          ...(args.assignees !== undefined ? { assignees: args.assignees } : {}),
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return {
        success: false,
        error: {
          code: 'CONCURRENCY_CONFLICT',
          message: `issue.create.requested append lost OCC race after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    if (err instanceof StorageBusyError) {
      return {
        success: false,
        error: {
          code: 'STORAGE_BUSY',
          message: `issue.create.requested append hit storage contention after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    throw err;
  }

  // ─── Phase B — idempotent check via operationId marker ───────────────────
  //
  // Before invoking `gh issue create`, query existing issues for the marker.
  // This handles the crash-recovery case: Phase A committed but the handler
  // crashed before Phase C. The issue exists on GitHub but `issue.create.executed`
  // was never committed. Detecting this via body marker avoids a duplicate.
  //
  // The scan MUST NOT silently fail-open: if we cannot determine whether a
  // prior invocation already created the issue, we MUST NOT proceed to
  // `provider.createIssue` (would create a duplicate on every retry). Surface
  // the failure to the caller — they can retry once the provider is healthy.
  // (CodeRabbit #3224631237 on PR #1348.)
  let existingIssue: IssueSummary | undefined;
  try {
    const candidates = await listIssuesByMarker(operationId);
    existingIssue = candidates.find((issue) => issue.body.includes(marker));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'PRECHECK_FAILED',
        message:
          `create_issue: recovery precheck (listIssuesByMarker) failed — refusing ` +
          `to proceed because re-firing gh issue create could create a duplicate. ` +
          `Underlying error: ${message}`,
      },
    };
  }

  if (existingIssue !== undefined) {
    // Issue already exists — emit `issue.create.executed` with the recovered
    // data. Failure to append here is NOT swallowed: it propagates upstream
    // so the operator can investigate and replay rather than silently leave
    // the stream stuck at issue.create.requested.
    await ctx.eventStore.append('vcs', {
      type: 'issue.create.executed',
      data: {
        operationId,
        issueNumber: existingIssue.number,
        url: existingIssue.url,
      },
    });
    return {
      success: true,
      data: {
        issueNumber: existingIssue.number,
        url: existingIssue.url,
        number: existingIssue.number,
      },
    };
  }

  // ─── Phase C — create the issue and emit `issue.create.executed` ─────────
  //
  // Embed the operationId marker in the body so future crash-recovery scans
  // can detect this issue without re-creating it. Assignees are threaded
  // through to the provider so the durable intent in issue.create.requested
  // matches what actually gets applied (CodeRabbit #3224631240).
  const markedBody = `${args.body}\n\n${marker}`;

  let result;
  try {
    result = await provider.createIssue({
      title: args.title,
      body: markedBody,
      labels: args.labels,
      assignees: args.assignees,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `create_issue failed: ${message}` },
    };
  }

  // Phase C event append — propagate failures upstream. Swallowing them
  // here would leave the stream stuck at issue.create.requested with no
  // operator signal that the executed record is missing.
  await ctx.eventStore.append('vcs', {
    type: 'issue.create.executed',
    data: {
      operationId,
      issueNumber: result.number,
      url: result.url,
    },
  });

  return { success: true, data: result };
}
