// ─── VCS Action: create_pr ───────────────────────────────────────────────────
//
// Creates a pull/merge request via the VCS provider abstraction.
//
// Two-event split (Wave B, B1.4 — audit INV-1 MEDIUM):
//
//   Phase A — durable INTENT:
//     Commit `pr.create.requested` via decide() with an operationId
//     (UUID) BEFORE invoking the VCS side effect (`gh pr create`).
//     `withStateRetry` retries OCC losses without re-firing the side effect.
//
//   Idempotent check (INV-1 MEDIUM):
//     Before invoking `gh pr create`, query listPrs for an existing PR
//     matching the requested (head, base). If found, skip the side effect
//     and emit `pr.create.executed` with the existing PR's data. This
//     covers the "requested-but-not-executed" recovery path: a prior
//     invocation succeeded at gh pr create but crashed before committing
//     `pr.create.executed`. The next invocation detects the existing PR
//     and emits `*.executed` referencing it instead of duplicating.
//
//   Phase B — durable RESULT:
//     Emit `pr.create.executed` after gh pr create succeeds (or after
//     the idempotent check short-circuits).
//
// The legacy `pr.created` event is preserved for backward compatibility
// during the rollout transition.

import { randomUUID } from 'node:crypto';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../../workflow/state-retry.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../../event-store/index.js';

export interface HandleCreatePrArgs {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft?: boolean;
  readonly labels?: string[];
}

export async function handleCreatePr(
  args: HandleCreatePrArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  // ─── Generate stable operationId for this invocation ──────────────────────
  // The operationId is the idempotency key for Phase A. Using randomUUID()
  // at handler entry means each top-level invocation gets a fresh key.
  // Retries (via withStateRetry) reuse the same key, so Phase A can only
  // commit once per invocation — the appender's built-in dedup short-circuits
  // any OCC-retry attempt after the first committed Phase A event.
  const operationId = randomUUID();

  const provider = await createVcsProvider({ config: ctx.projectConfig });

  // ─── Phase A — durable INTENT ─────────────────────────────────────────────
  //
  // Commit `pr.create.requested` BEFORE the `gh pr create` side effect.
  // `withStateRetry` retries OCC losses; `operationId` ensures the decide
  // closure short-circuits on the second attempt if Phase A already committed
  // (prevents duplicate `pr.create.requested` events on retry).
  const appender = ctx.eventStore.getAppender();
  try {
    await withStateRetry(() =>
      appender.decide(
        'vcs',
        'vcs-ops@v1',
        // The decide closure is idempotent: even if decide is called multiple
        // times under OCC retries, only one `pr.create.requested` event lands.
        (_state: unknown) => [
          {
            type: 'pr.create.requested',
            data: {
              operationId,
              title: args.title,
              body: args.body,
              base: args.base,
              head: args.head,
              ...(args.draft !== undefined ? { draft: args.draft } : {}),
              ...(args.labels !== undefined ? { labels: args.labels } : {}),
            },
          },
        ],
        { operationId },
      ),
    );
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return {
        success: false,
        error: {
          code: 'CONCURRENCY_CONFLICT',
          message: `pr.create.requested decide lost OCC race after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    if (err instanceof StorageBusyError) {
      return {
        success: false,
        error: {
          code: 'STORAGE_BUSY',
          message: `pr.create.requested decide hit storage contention after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    throw err;
  }

  // ─── Idempotent side-effect check (INV-1 MEDIUM) ─────────────────────────
  //
  // Before invoking gh pr create, check whether a PR already exists for
  // the requested (head, base) pair. This catches the recovery scenario:
  //   • Prior invocation committed `pr.create.requested` and called gh pr create.
  //   • gh pr create succeeded but the process crashed before `pr.create.executed`
  //     was committed.
  //   • This invocation sees `pr.create.requested` as a noop (decide above),
  //     then detects the existing PR and emits `pr.create.executed` without
  //     creating a duplicate.
  try {
    const existingPrs = await provider.listPrs({
      state: 'open',
      head: args.head,
      base: args.base,
    });
    const existing = existingPrs.find(
      (pr) => pr.headRefName === args.head && pr.baseRefName === args.base,
    );

    if (existing !== undefined) {
      // PR already exists — emit Phase B event and return without re-firing
      // the gh pr create side effect.
      await ctx.eventStore.append('vcs', {
        type: 'pr.create.executed',
        data: {
          operationId,
          prNumber: existing.number,
          url: existing.url,
        },
      });
      return {
        success: true,
        data: { url: existing.url, number: existing.number },
      };
    }
  } catch (err: unknown) {
    // listPrs failure is non-fatal for the idempotent check: if we cannot
    // determine whether the PR already exists, fall through to create it.
    // The worst case is a duplicate PR that the operator must de-duplicate
    // manually — which is preferable to failing the entire operation when
    // listPrs is temporarily unavailable.
    //
    // Structured errors from the VCS provider (e.g. auth failure) will also
    // surface during `createPr` below, so the operator will still see the error.
    void err;
  }

  // ─── Side effect: invoke gh pr create ─────────────────────────────────────
  try {
    const result = await provider.createPr({
      title: args.title,
      body: args.body,
      baseBranch: args.base,
      headBranch: args.head,
      draft: args.draft,
      labels: args.labels,
    });

    // ─── Phase B — durable RESULT ────────────────────────────────────────────
    await ctx.eventStore.append('vcs', {
      type: 'pr.create.executed',
      data: {
        operationId,
        prNumber: result.number,
        url: result.url,
      },
    });

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `create_pr failed: ${message}` },
    };
  }
}
