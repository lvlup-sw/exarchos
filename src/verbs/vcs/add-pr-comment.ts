/**
 * The `add_pr_comment` VCS action. It posts a PR comment, or a reply into a
 * review thread, through the VCS provider, in a two-event split:
 *
 * 1. Append `pr.comment.requested` before the side effect, with retry on
 *    contention.
 * 2. Scan the PR comments for the marker `<!-- exarchos-op:<operationId> -->`.
 *    A match means that the side effect already ran, so record
 *    `pr.comment.executed` from that comment.
 * 3. Otherwise, post the body with the marker, find the comment id, and append
 *    `pr.comment.executed`.
 *
 * A caller can inject `operationId` for crash recovery. Otherwise, each call
 * generates a UUID.
 */

import { randomUUID } from 'node:crypto';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../../events/index.js';
import { SequenceConflictError } from '../../events/store.js';
import { SqliteBusyExhaustedError } from '../../storage/sqlite/errors.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../../workflow/state-retry.js';

/**
 * Map the errors of `EventStore.append` to the classes that `withStateRetry`
 * and the handler catch. The plain append throws `SequenceConflictError` and
 * the raw `SqliteBusyExhaustedError`, and `isRetryable` recognizes neither.
 */
function translateStorageError(err: unknown): never {
  if (err instanceof SqliteBusyExhaustedError) {
    throw new StorageBusyError({ streamId: 'vcs', attempts: 1, cause: err });
  }
  if (err instanceof SequenceConflictError) {
    throw new ConcurrencyError({
      streamId: 'vcs',
      reducerId: 'add-pr-comment',
      expectedVersion: err.expected,
      actualVersion: err.actual,
    });
  }
  throw err;
}

export interface HandleAddPrCommentArgs {
  readonly prId: string;
  readonly body: string;
  /**
   * When present, post the body as a reply into this review-comment thread
   * (`addReply`), not as a PR-level comment (`addComment`). It is the id of the
   * top-level review comment, in the same id space as `PrComment.id`.
   */
  readonly threadId?: string;
  /**
   * Idempotency key. When it is absent, the handler generates a fresh UUID.
   * Pass a known UUID to recover after `pr.comment.requested` committed under it.
   */
  readonly operationId?: string;
}

/** Marker embedded into the comment body to enable idempotency detection. */
function buildMarker(operationId: string): string {
  return `<!-- exarchos-op:${operationId} -->`;
}

/**
 * Post the comment and record the two events.
 *
 * `operationId` must be a v1 to v5 UUID, because a bad value corrupts the
 * marker. `prId` and `threadId` must be positive decimal integers, because
 * `parseInt` accepts trailing characters. The intent uses a plain append, so
 * the row carries the ambient dispatch operation id. When the re-query cannot
 * find the posted comment, the call fails and leaves only the intent. The
 * schema requires a positive `commentId`, so no sentinel is written.
 */
export async function handleAddPrComment(
  args: HandleAddPrCommentArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
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
    const phaseAKey = `pr-comment-requested:${operationId}`;

    try {
      await withStateRetry(async () => {
        try {
          await ctx.eventStore.append(
            'vcs',
            {
              type: 'pr.comment.requested',
              data: {
                operationId,
                prNumber,
                body: args.body,
                ...(args.threadId !== undefined
                  ? { threadId: parseInt(args.threadId, 10) }
                  : {}),
              },
            },
            { idempotencyKey: phaseAKey },
          );
        } catch (err) {
          translateStorageError(err);
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

    const existingComments = await provider.getPrComments(args.prId);
    const existingComment = existingComments.find((c) => c.body.includes(marker));

    if (existingComment) {
      const repo = await provider.getRepository();
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

    const markedBody = `${args.body}\n\n${marker}`;

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

    const updatedComments = await provider.getPrComments(args.prId);
    const postedComment = updatedComments.find((c) => c.body.includes(marker));

    if (!postedComment) {
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
