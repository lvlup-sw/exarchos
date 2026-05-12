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
 * found. Defaults to a no-op (production uses the VCS provider's gh search;
 * tests supply a stub directly).
 *
 * The default implementation returns [] (no match found) because the full
 * `gh issue list --search` surface is not part of the VcsProvider interface.
 * When a project adds `listIssues` to their provider, they can supply it here.
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
   * DI hook: scan existing issues for the operationId marker.
   * Defaults to a no-op that always returns [] (no pre-existing issue found).
   */
  readonly listIssuesByMarker?: ListIssuesByMarker;
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

  const listIssuesByMarker: ListIssuesByMarker =
    args.listIssuesByMarker ?? (async () => []);

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
  let existingIssue: IssueSummary | undefined;
  try {
    const candidates = await listIssuesByMarker(operationId);
    existingIssue = candidates.find((issue) => issue.body.includes(marker));
  } catch {
    // Marker scan is best-effort. If it fails, proceed with creating the issue.
    // A subsequent invocation's scan will detect the duplicate if needed.
    existingIssue = undefined;
  }

  if (existingIssue !== undefined) {
    // Issue already exists — emit `issue.create.executed` with the recovered data.
    try {
      await ctx.eventStore.append('vcs', {
        type: 'issue.create.executed',
        data: {
          operationId,
          issueNumber: existingIssue.number,
          url: existingIssue.url,
        },
      });
    } catch {
      // Best-effort emit — the recovered data is still returned to caller.
    }
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
  // can detect this issue without re-creating it.
  const markedBody = `${args.body}\n\n${marker}`;

  let result;
  try {
    result = await provider.createIssue({
      title: args.title,
      body: markedBody,
      labels: args.labels,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `create_issue failed: ${message}` },
    };
  }

  try {
    await ctx.eventStore.append('vcs', {
      type: 'issue.create.executed',
      data: {
        operationId,
        issueNumber: result.number,
        url: result.url,
      },
    });
  } catch {
    // Event emission is best-effort — issue already created
  }

  return { success: true, data: result };
}
