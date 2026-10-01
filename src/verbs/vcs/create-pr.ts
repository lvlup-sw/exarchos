/**
 * The `create_pr` VCS action. It creates a pull request through the VCS
 * provider, in a two-event split on the shared `vcs` stream:
 *
 * 1. Append `pr.create.requested` before the side effect.
 * 2. Look for an open PR with the same head and base. If one exists, a prior
 *    call created it, so record `pr.create.executed` for it.
 * 3. Otherwise, create the PR and append `pr.create.executed`.
 *
 * The idempotency keys derive from the ambient operation id, so a retry of the
 * same operation collapses onto the first rows. Outside a dispatch scope, the
 * key is a per-call UUID. A new MCP request is a new operation, so only the
 * open-PR check covers its retry.
 */

import { randomUUID } from 'node:crypto';

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../../workflow/state-retry.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../../events/index.js';
import { readIntent, groundBodyInIntent } from '../tasks/extract-intent.js';
import { resolveWorkflowState } from '../resolve-state.js';

export interface HandleCreatePrArgs {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft?: boolean;
  readonly labels?: string[];
  /**
   * Selects the workflow for the single-PR-owner guard. The handler also reads
   * its `artifacts.intent` and adds an `## Intent` section to the body, so the
   * `pr.create.requested` event and the PR carry the same body. A missing,
   * unreadable, or empty intent leaves the body unchanged.
   */
  readonly featureId?: string;
}

/**
 * A workflow "owns a PR" when its projected state records a non-empty PR
 * reference — either `artifacts.pr` or `synthesis.prUrl`. The projection types
 * both as `string | string[] | null`, so a recorded PR is a non-empty string OR
 * a non-empty array. `null`, `undefined`, `''`, and `[]` all mean "no PR yet".
 */
function recordsPr(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/**
 * Create the PR, unless the workflow of `featureId` already records one.
 *
 * Only the initial synthesize creates a PR. The shepherd loop runs in the same
 * phase, so the guard reads projected state, not the phase. Missing or
 * unreadable state takes the normal create path. A failed open-PR lookup fails
 * closed, because a retry can then open a duplicate PR.
 * `check-withsession-idempotency.sh` does not scan this file, so only review
 * and `create-pr.test.ts` hold the key discipline.
 */
export async function handleCreatePr(
  args: HandleCreatePrArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  if (args.featureId !== undefined) {
    const resolved = await resolveWorkflowState({
      featureId: args.featureId,
      eventStore: ctx.eventStore,
    });
    if ('state' in resolved) {
      const artifacts = resolved.state.artifacts as
        | { pr?: unknown }
        | undefined;
      const synthesis = resolved.state.synthesis as
        | { prUrl?: unknown }
        | undefined;
      if (recordsPr(artifacts?.pr) || recordsPr(synthesis?.prUrl)) {
        return {
          success: false,
          error: {
            code: 'PR_ALREADY_OWNED',
            message:
              `create_pr refused: feature '${args.featureId}' already owns a PR. ` +
              `Only the initial synthesize creates a PR for a feature; the ` +
              `shepherd loop can only push/assess, never create_pr (single PR ` +
              `owner — DR-4). No PR was created.`,
          },
        };
      }
    }
  }

  const operationId = randomUUID();
  const keySuffix = getDispatchContext()?.operationId ?? operationId;
  const phaseAKey = `pr.create.requested:${keySuffix}`;
  const phaseBKey = `pr.create.executed:${keySuffix}`;

  const intent = await readIntent(args.featureId, ctx.eventStore);
  const effectiveBody =
    intent !== undefined ? groundBodyInIntent(args.body, intent) : args.body;

  const provider = await createVcsProvider({ config: ctx.projectConfig });

  try {
    await withStateRetry(() =>
      ctx.eventStore.append(
        'vcs',
        {
          type: 'pr.create.requested',
          data: {
            operationId,
            title: args.title,
            body: effectiveBody,
            base: args.base,
            head: args.head,
            ...(args.draft !== undefined ? { draft: args.draft } : {}),
            ...(args.labels !== undefined ? { labels: args.labels } : {}),
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
          message: `pr.create.requested append lost OCC race after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    if (err instanceof StorageBusyError) {
      return {
        success: false,
        error: {
          code: 'STORAGE_BUSY',
          message: `pr.create.requested append hit storage contention after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'APPEND_FAILED',
        message: `pr.create.requested append failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  let existing:
    | { number: number; url: string; headRefName: string; baseRefName: string }
    | undefined;
  try {
    const existingPrs = await provider.listPrs({
      state: 'open',
      head: args.head,
      base: args.base,
    });
    existing = existingPrs.find(
      (pr) => pr.headRefName === args.head && pr.baseRefName === args.base,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'PRECHECK_FAILED',
        message:
          `create_pr: recovery precheck (listPrs) failed — refusing to ` +
          `proceed because re-firing gh pr create could create a duplicate ` +
          `PR. Underlying error: ${message}`,
      },
    };
  }

  if (existing !== undefined) {
    await ctx.eventStore.append(
      'vcs',
      {
        type: 'pr.create.executed',
        data: {
          operationId,
          prNumber: existing.number,
          url: existing.url,
        },
      },
      { idempotencyKey: phaseBKey },
    );
    return {
      success: true,
      data: { url: existing.url, number: existing.number },
    };
  }

  try {
    const result = await provider.createPr({
      title: args.title,
      body: effectiveBody,
      baseBranch: args.base,
      headBranch: args.head,
      draft: args.draft,
      labels: args.labels,
    });

    await ctx.eventStore.append(
      'vcs',
      {
        type: 'pr.create.executed',
        data: {
          operationId,
          prNumber: result.number,
          url: result.url,
        },
      },
      { idempotencyKey: phaseBKey },
    );

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `create_pr failed: ${message}` },
    };
  }
}
