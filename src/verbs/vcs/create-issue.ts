/**
 * `create_issue` handler. It creates an issue through the VCS provider in three phases:
 *   1. Append `issue.create.requested` before the non-idempotent `gh issue create` call.
 *   2. Scan for an issue whose body holds the `<!-- exarchos-op:UUID -->` marker. If one exists,
 *      append `issue.create.executed` for it and create nothing.
 *   3. Create the issue with the marker in its body, then append `issue.create.executed`.
 * A crash can occur between phases 1 and 3. A later call with the same title and body, or the same
 * `operationId`, then reuses the operation id and finds the issue by its marker. Thus no duplicate
 * issue occurs.
 */

import { randomUUID } from 'node:crypto';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';
import {
  withStateRetry,
} from '../../workflow/state-retry.js';
import { ConcurrencyError, StorageBusyError } from '../../events/index.js';
import { MAX_STATE_RETRIES } from '../../workflow/state-retry.js';

/** Returns the HTML comment marker for the issue body. The rendered issue does not show it. */
function buildBodyMarker(operationId: string): string {
  return `<!-- exarchos-op:${operationId} -->`;
}

export interface IssueSummary {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

/**
 * Returns the existing issues whose body holds the marker for `operationId`, and throws on a
 * provider failure. It has no default, because an empty default disables the recovery scan. A
 * crash retry then creates a duplicate issue. The composite handler injects the provider
 * `searchIssuesByMarker`.
 */
export type ListIssuesByMarker = (operationId: string) => Promise<IssueSummary[]>;

export interface HandleCreateIssueArgs {
  readonly title: string;
  readonly body: string;
  readonly labels?: string[];
  readonly assignees?: string[];

  /**
   * Stable operation id for a recovery or a retry. The handler puts this exact id in the body
   * marker, so the marker scan finds the earlier issue. When it is absent, the handler resolves one.
   */
  readonly operationId?: string;

  /** Required marker scan. See {@link ListIssuesByMarker}. */
  readonly listIssuesByMarker: ListIssuesByMarker;
}

interface IssueRequestedData {
  readonly operationId: string;
  readonly title: string;
  readonly body: string;
}

interface IssueExecutedData {
  readonly operationId: string;
}

/**
 * Returns the `operationId` of the newest `issue.create.requested` on the `vcs` stream that matches
 * this title and body and has no `issue.create.executed`. It returns `undefined` when none exists.
 * A query error throws and does not fall back to a fresh UUID. A fresh UUID makes the marker scan
 * miss the issue of a crashed call.
 */
async function recoverOperationId(
  ctx: DispatchContext,
  args: HandleCreateIssueArgs,
): Promise<string | undefined> {
  const requested = await ctx.eventStore.query('vcs', {
    type: 'issue.create.requested',
  });
  const executed = await ctx.eventStore.query('vcs', {
    type: 'issue.create.executed',
  });
  const executedOps = new Set(
    executed.map((e) => (e.data as unknown as IssueExecutedData).operationId),
  );
  for (let i = requested.length - 1; i >= 0; i -= 1) {
    const entry = requested[i];
    if (entry === undefined) continue;
    const data = entry.data as unknown as IssueRequestedData;
    if (executedOps.has(data.operationId)) continue;
    if (data.title === args.title && data.body === args.body) {
      return data.operationId;
    }
  }
  return undefined;
}

/**
 * Creates one issue. A caller `operationId` wins, then the result of {@link recoverOperationId},
 * then a fresh UUID. The append keys use the ambient dispatch operation id, as in `create-pr.ts`.
 * A retry inside one dispatch then collapses onto the first row. A new dispatch gets its own rows,
 * which the emission verifier needs.
 *
 * Only the phase 1 append is inside `withStateRetry`, so the provider call is outside the retry.
 * A failed recovery query or marker scan returns `PRECHECK_FAILED`. A failed
 * `issue.create.executed` append throws.
 */
export async function handleCreateIssue(
  args: HandleCreateIssueArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const provider = await createVcsProvider({ config: ctx.projectConfig });

  let operationId: string;
  try {
    operationId = args.operationId ?? (await recoverOperationId(ctx, args)) ?? randomUUID();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'PRECHECK_FAILED',
        message:
          `create_issue: recovery operationId scan (eventStore.query) failed — ` +
          `refusing to proceed because minting a fresh UUID after a prior ` +
          `crash would create a duplicate issue. Underlying error: ${message}`,
      },
    };
  }
  const marker = buildBodyMarker(operationId);

  const keySuffix = getDispatchContext()?.operationId ?? operationId;
  const phaseAKey = `issue.create.requested:${keySuffix}`;
  const phaseBKey = `issue.create.executed:${keySuffix}`;

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

  try {
    await withStateRetry(() =>
      ctx.eventStore.append(
        'vcs',
        {
          type: 'issue.create.requested',
          data: {
            operationId,
            title: args.title,
            body: args.body,
            ...(args.labels !== undefined ? { labels: args.labels } : {}),
            ...(args.assignees !== undefined ? { assignees: args.assignees } : {}),
          },
        },
        { idempotencyKey: phaseAKey },
      ),
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
    await ctx.eventStore.append(
      'vcs',
      {
        type: 'issue.create.executed',
        data: {
          operationId,
          issueNumber: existingIssue.number,
          url: existingIssue.url,
        },
      },
      { idempotencyKey: phaseBKey },
    );
    return {
      success: true,
      data: {
        issueNumber: existingIssue.number,
        url: existingIssue.url,
        number: existingIssue.number,
      },
    };
  }

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

  await ctx.eventStore.append(
    'vcs',
    {
      type: 'issue.create.executed',
      data: {
        operationId,
        issueNumber: result.number,
        url: result.url,
      },
    },
    { idempotencyKey: phaseBKey },
  );

  return { success: true, data: result };
}
