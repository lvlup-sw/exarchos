// ─── VCS Action: add_pr_comment ─────────────────────────────────────────────
//
// Adds a comment to a pull/merge request via the VCS provider abstraction.
//
// Two-event split (Wave B / B2.4, INV-1 MEDIUM audit requirement):
//   Phase A — commit `pr.comment.requested` (durable intent) via appendComputed
//             keyed by operationId BEFORE the gh pr comment side effect fires.
//             Wrapped in withStateRetry so ConcurrencyError / StorageBusyError
//             on the append don't abort the handler.
//
//   Idempotency check (B2.3) — before invoking gh pr comment, query existing
//             comments for the PR and scan each body for the marker
//             `<!-- exarchos-op:${operationId} -->`. If found, skip the side
//             effect and emit pr.comment.executed with the existing comment's
//             data (crash-recovery path: Phase A committed, process died before
//             Phase C).
//
//   Phase C — embed the marker into the body, call addComment, re-query to
//             find the newly posted comment by marker, emit pr.comment.executed.
//
// The operationId can be injected via args for crash-recovery / test scenarios;
// when not supplied, a fresh UUID is generated at handler entry.

import { randomUUID } from 'node:crypto';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../../event-store/index.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../../workflow/state-retry.js';
import type { AppendResult } from '../../event-store/index.js';

// ─── Args ─────────────────────────────────────────────────────────────────────

export interface HandleAddPrCommentArgs {
  readonly prId: string;
  readonly body: string;
  /**
   * When present, post the body as a **reply into the existing review-comment
   * thread** identified by this id (provider-agnostic `addReply`), instead of a
   * PR-level conversation comment (`addComment`). This is the id of the
   * top-level review comment being answered — the same id space as
   * `PrComment.id` / `PrComment.parentId`. Absent ⇒ PR-level comment (the
   * original behavior). Keeps the thread-reply step provider-agnostic so
   * shepherd no longer falls back to platform-specific GitHub calls (INV-2).
   */
  readonly threadId?: string;
  /**
   * Idempotency key for the operation. When omitted a fresh UUID is generated.
   * Inject a stable UUID in tests or crash-recovery scenarios where Phase A
   * (`pr.comment.requested`) was already committed with a known operationId.
   */
  readonly operationId?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Marker embedded into the comment body to enable idempotency detection. */
function buildMarker(operationId: string): string {
  return `<!-- exarchos-op:${operationId} -->`;
}

/** Translate an AppendResult failure to a typed error that withStateRetry can retry. */
function translateAppendFailure(result: AppendResult & { ok: false }, streamId: string): never {
  if (result.reason === 'sequence-conflict') {
    throw new ConcurrencyError({
      streamId,
      reducerId: 'add-pr-comment',
      expectedVersion: result.expected ?? -1,
      actualVersion: result.actual ?? -1,
    });
  }
  if (result.reason === 'storage_busy') {
    throw new StorageBusyError({
      streamId,
      attempts: 1,
      cause: result.cause ?? new Error('storage_busy'),
    });
  }
  throw result.cause ?? new Error(`Append failed: ${result.reason}`);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleAddPrComment(
  args: HandleAddPrCommentArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    // Validate caller-supplied operationId — an empty/whitespace/non-UUID value
    // would corrupt the idempotency marker (`<!-- exarchos-op:${operationId} -->`),
    // collide with other in-flight requests, and silently break the crash-recovery
    // contract. Reject up front rather than baking a malformed marker into the
    // durable Phase-A append. RFC 4122 v1–v5 UUID shape only.
    if (args.operationId !== undefined) {
      const v = String(args.operationId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {
        return {
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: `add_pr_comment: operationId must be a UUID, got "${v}"`,
          },
        };
      }
    }
    const operationId = args.operationId ?? randomUUID();
    const marker = buildMarker(operationId);
    // Strict numeric validation: parseInt accepts trailing non-digits
    // ("42abc" → 42, "1.9" → 1) and would silently route the comment to
    // the wrong PR. The /^[1-9]\d*$/ pattern requires the entire string
    // to be a positive decimal integer with no leading zeros, sign, or
    // suffix. (CodeRabbit review #4278133032 on PR #1344.)
    if (!/^[1-9]\d*$/.test(args.prId)) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `add_pr_comment: prId must be a positive integer, got "${args.prId}"`,
        },
      };
    }
    const prNumber = parseInt(args.prId, 10);

    // threadId, when supplied, routes the body through the provider-agnostic
    // addReply path. It is the id of an existing review comment, so the same
    // strict positive-integer guard applies — a malformed value would corrupt
    // the reply endpoint path and silently 404 or hit the wrong thread.
    if (args.threadId !== undefined && !/^[1-9]\d*$/.test(args.threadId)) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `add_pr_comment: threadId must be a positive integer, got "${args.threadId}"`,
        },
      };
    }

    const provider = await createVcsProvider({ config: ctx.projectConfig });
    const appender = ctx.eventStore.getAppender();
    const phaseAKey = `pr-comment-requested:${operationId}`;

    // ─── Phase A — durable INTENT ──────────────────────────────────────────
    //
    // Commit pr.comment.requested via appendComputed keyed by operationId
    // BEFORE the side effect fires. withStateRetry catches ConcurrencyError
    // and StorageBusyError from the append and retries — the addComment call
    // lives OUTSIDE this retry boundary (canonical two-event split property).
    try {
      await withStateRetry(async () => {
        const result = await appender.appendComputed(
          'vcs',
          phaseAKey,
          async () => [
            {
              type: 'pr.comment.requested',
              data: {
                operationId,
                prNumber,
                body: args.body,
                // Record the reply target in the durable intent so the audit
                // trail distinguishes a thread reply from a PR-level comment.
                ...(args.threadId !== undefined
                  ? { threadId: parseInt(args.threadId, 10) }
                  : {}),
              },
            },
          ],
        );
        if (!result.ok) {
          translateAppendFailure(result, 'vcs');
        }
      });
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        return {
          success: false,
          error: {
            code: 'CONCURRENCY_CONFLICT',
            message: `pr.comment.requested append lost OCC race after ${MAX_STATE_RETRIES} retries: ${err.message}`,
          },
        };
      }
      if (err instanceof StorageBusyError) {
        return {
          success: false,
          error: {
            code: 'STORAGE_BUSY',
            message: `pr.comment.requested append hit storage contention after ${MAX_STATE_RETRIES} retries: ${err.message}`,
          },
        };
      }
      throw err;
    }

    // ─── Idempotency check (B2.3) ──────────────────────────────────────────
    //
    // Before invoking addComment, query existing comments for this PR and
    // scan each body for the operationId marker. If found, the side effect
    // already ran (crash-recovery path). Emit pr.comment.executed with the
    // existing comment's data and return — no duplicate comment posted.
    const existingComments = await provider.getPrComments(args.prId);
    const existingComment = existingComments.find((c) => c.body.includes(marker));

    if (existingComment) {
      // Side effect already ran — recover from event between *.requested and *.executed.
      const repo = await provider.getRepository();
      // A recovered thread reply uses the #discussion_r anchor; a top-level PR
      // comment uses #issuecomment- (matches the fresh-path anchors below).
      const anchor =
        args.threadId !== undefined
          ? `discussion_r${existingComment.id}`
          : `issuecomment-${existingComment.id}`;
      const commentUrl = `https://github.com/${repo.nameWithOwner}/pull/${args.prId}#${anchor}`;

      await ctx.eventStore.append(
        'vcs',
        {
          type: 'pr.comment.executed',
          data: {
            operationId,
            commentId: existingComment.id,
            url: commentUrl,
          },
        },
        { idempotencyKey: `pr-comment-executed:${operationId}` },
      );

      return { success: true };
    }

    // ─── Phase B — side effect ─────────────────────────────────────────────
    //
    // Embed the marker into the body (appended after a blank line so it stays
    // out of the way of human readers), then post it.
    const markedBody = `${args.body}\n\n${marker}`;

    // Reply path: route through the provider-agnostic addReply, which posts
    // into the review-comment thread and returns the new reply's id directly —
    // no Phase-C re-query needed, because addReply hands back the commentId.
    // This keeps shepherd's per-thread reply step on the agnostic surface
    // (INV-2) instead of falling back to platform-specific GitHub calls.
    if (args.threadId !== undefined) {
      const reply = await provider.addReply(args.prId, args.threadId, markedBody);
      const repo = await provider.getRepository();
      const replyUrl = `https://github.com/${repo.nameWithOwner}/pull/${args.prId}#discussion_r${reply.id}`;

      await ctx.eventStore.append(
        'vcs',
        {
          type: 'pr.comment.executed',
          data: {
            operationId,
            commentId: reply.id,
            url: replyUrl,
          },
        },
        { idempotencyKey: `pr-comment-executed:${operationId}` },
      );

      return { success: true };
    }

    await provider.addComment(args.prId, markedBody);

    // ─── Phase C — find posted comment + emit pr.comment.executed ──────────
    //
    // Re-query comments to locate the newly posted comment by its marker.
    // This gives us the commentId. Construct the URL from repo info.
    const updatedComments = await provider.getPrComments(args.prId);
    const postedComment = updatedComments.find((c) => c.body.includes(marker));

    if (!postedComment) {
      // The comment was posted (addComment succeeded above) but the follow-up
      // lookup did not return it — typically eventual consistency in the
      // comments API.
      //
      // The schema for `pr.comment.executed` requires `commentId` to be a
      // POSITIVE integer (PrCommentExecutedData in event-store/schemas.ts).
      // Writing a sentinel value like `0` would corrupt the audit trail with
      // a schema-violating event (INV-1 violation). Omitting `commentId` is
      // not an option either — the field is required.
      //
      // Instead surface the failure: the comment exists on GitHub (with the
      // marker embedded), so a subsequent invocation will hit the recovery
      // branch above and emit a well-formed pr.comment.executed once the
      // comments API catches up. The stream is intentionally left at
      // `pr.comment.requested` until verification succeeds.
      return {
        success: false,
        error: {
          code: 'VCS_VERIFICATION_FAILED',
          message:
            `add_pr_comment: comment was posted for PR ${args.prId} but the verification ` +
            `lookup did not return it (operationId=${operationId}). A subsequent ` +
            `invocation will recover via the marker scan once the comments API is ` +
            `consistent.`,
        },
      };
    }

    const repo = await provider.getRepository();
    const commentUrl = `https://github.com/${repo.nameWithOwner}/pull/${args.prId}#issuecomment-${postedComment.id}`;

    // Phase C: emit pr.comment.executed with the verified comment data.
    await ctx.eventStore.append(
      'vcs',
      {
        type: 'pr.comment.executed',
        data: {
          operationId,
          commentId: postedComment.id,
          url: commentUrl,
        },
      },
      { idempotencyKey: `pr-comment-executed:${operationId}` },
    );

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `add_pr_comment failed: ${message}` },
    };
  }
}
