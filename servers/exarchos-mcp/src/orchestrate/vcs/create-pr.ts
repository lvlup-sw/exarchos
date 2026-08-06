// ─── VCS Action: create_pr ───────────────────────────────────────────────────
//
// Creates a pull/merge request via the VCS provider abstraction.
//
// Two-event split (Wave B, B1.4 — audit INV-1 MEDIUM):
//
//   Phase A — durable INTENT:
//     Append `pr.create.requested` with an idempotencyKey derived from
//     `operationId` (UUID) BEFORE invoking the VCS side effect (`gh pr create`).
//     `withStateRetry` retries OCC / storage-busy losses; the idempotencyKey
//     deduplicates Phase A on replay so exactly one `pr.create.requested` event
//     lands per logical invocation even under retry storms.
//
//   Idempotent check (INV-1 MEDIUM):
//     Before invoking `gh pr create`, query listPrs for an existing PR matching
//     the requested (head, base). If found, skip the side effect and emit
//     `pr.create.executed` with the existing PR's data. This covers the
//     "requested-but-not-executed" recovery path: a prior invocation succeeded
//     at gh pr create but crashed before committing `pr.create.executed`.
//     The next invocation detects the existing PR and emits `*.executed`
//     referencing it instead of creating a duplicate.
//
//   Phase B — durable RESULT:
//     Emit `pr.create.executed` after gh pr create succeeds (or after the
//     idempotent short-circuit). The operationId correlates the two events.
//
// The idempotencyKey pattern (`pr.create.requested:${operationId}` and
// `pr.create.executed:${operationId}`) satisfies the withSession idempotency
// contract (audit §F1.1) without requiring a registered projection reducer —
// Phase A and Phase B are unconditional appends, not decide() closures.

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
import { readIntent, groundBodyInIntent } from '../extract-intent.js';
import { resolveWorkflowState } from '../resolve-state.js';

export interface HandleCreatePrArgs {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft?: boolean;
  readonly labels?: string[];
  /**
   * DR-1 (#1593) task 006: when present, the handler fail-soft reads
   * `artifacts.intent` and grounds the PR body in it (a deterministic `##
   * Intent` section) so BOTH the durable `pr.create.requested` event AND the
   * created PR carry the grounded body. Absent / unreadable / empty intent →
   * the body is left untouched (unchanged legacy behavior).
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

export async function handleCreatePr(
  args: HandleCreatePrArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  // ─── DR-4 (#1596) task 007 — structural single-PR-owner guard ─────────────
  //
  // FIRST step, before ANY side effect (body grounding, Phase A, provider
  // calls). Synthesize is the sole PR creator: the initial /synthesize runs
  // create_pr exactly once, and the shepherd loop that follows can only
  // push/assess — it has no create_pr path. Shepherd runs WITHIN the SYNTHESIZE
  // phase, so phase-gating cannot separate the initial create from a shepherd
  // resubmit. The only by-construction differentiator is workflow STATE: once
  // the initial create succeeds, the workflow already OWNS a PR. That is exactly
  // shepherd's documented precondition ("create_pr already ran"). So we refuse
  // any create_pr whose feature already records a PR.
  //
  // The refusal is derived from authoritative event-sourced state (the
  // projection), NOT a caller-passed boolean — there is no `shepherdContext`
  // flag and no `workflowType` branch (INV-6). Fail-soft: a missing featureId,
  // an unreadable state, or no recorded PR all DEGRADE to the unchanged legacy
  // create path (the listPrs remote-recovery guard below still backstops the
  // crash-recovery window before state records the PR). The state read NEVER
  // throws out of this guard.
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
    // `{ error }` (state unreadable) → degrade to the legacy create path.
  }

  // ─── Generate stable operationId for this invocation ──────────────────────
  // The operationId is the idempotency anchor for both Phase A and Phase B.
  // Using randomUUID() at handler entry means each top-level invocation gets a
  // fresh key. Retries (via withStateRetry) reuse the SAME operationId so the
  // EventStore's built-in idempotencyKey dedup short-circuits any re-append
  // of Phase A after the first committed `pr.create.requested` event.
  const operationId = randomUUID();
  const phaseAKey = `pr.create.requested:${operationId}`;
  const phaseBKey = `pr.create.executed:${operationId}`;

  // ─── DR-1 task 006 — ground the PR body in artifacts.intent ───────────────
  //
  // BEFORE Phase A: fail-soft read the persisted intent and, when it is
  // meaningful and the body is not already grounded, append a deterministic `##
  // Intent` section + idempotency marker. The ENRICHED body is used for the
  // rest of the handler so BOTH the durable `pr.create.requested` event AND the
  // created PR carry the grounded body. `readIntent`/`groundBodyInIntent` never
  // throw and degrade to the unchanged body when no featureId / no meaningful
  // intent / state unreadable — never breaking PR creation on a state hiccup.
  // INV-6: no `workflowType` branch.
  const intent = await readIntent(args.featureId, ctx.eventStore);
  const effectiveBody =
    intent !== undefined ? groundBodyInIntent(args.body, intent) : args.body;

  const provider = await createVcsProvider({ config: ctx.projectConfig });

  // ─── Phase A — durable INTENT ─────────────────────────────────────────────
  //
  // Commit `pr.create.requested` BEFORE the `gh pr create` side effect.
  // `withStateRetry` retries OCC / StorageBusy losses. The idempotencyKey
  // ensures only one `pr.create.requested` lands per operationId: the
  // EventStore deduplicates on key-match so a retry does NOT re-emit Phase A.
  //
  // NOTE: `check-withsession-idempotency.sh` does NOT check this file. That
  // gate selects files solely by the presence of a `.withSession(` call site,
  // and this handler has none — it appends directly. create-pr.ts is therefore
  // never scanned, so the gate can neither pass nor fail it, and it will not
  // catch a regression here. The `idempotencyKey: phaseAKey` discipline below
  // is equivalent in intent to the gate's `operationId` pattern, but it is
  // held only by review and by the tests in `create-pr.test.ts`.
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
    // Neither known retry-class error — return a coded envelope rather than
    // letting this escape (#1706 DR-1): dispatch.ts's safety net would
    // otherwise flatten it to a generic INTERNAL_ERROR, discarding the
    // append-failure classification this handler's own vocabulary uses
    // elsewhere (request-synthesize.ts's APPEND_FAILED precedent).
    return {
      success: false,
      error: {
        code: 'APPEND_FAILED',
        message: `pr.create.requested append failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // ─── Idempotent side-effect check (INV-1 MEDIUM) ─────────────────────────
  //
  // Before invoking gh pr create, check whether a PR already exists for the
  // requested (head, base) pair. This catches the recovery scenario:
  //   • Prior invocation committed `pr.create.requested` and called gh pr create.
  //   • gh pr create succeeded but the process crashed before `pr.create.executed`
  //     was committed.
  //   • This invocation's Phase A idempotencyKey dedup sees `pr.create.requested`
  //     already committed (no-op), then detects the existing PR here and emits
  //     `pr.create.executed` without creating a duplicate.
  //
  // The try/catch is narrowed to the listPrs() call ONLY. If listPrs succeeds
  // but the recovery-path `pr.create.executed` append fails, we MUST NOT fall
  // through to provider.createPr() — that would open a duplicate PR. The append
  // is wrapped in its own try below and propagates failures upstream.
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
    // The recovery precheck MUST NOT fail-open: if listPrs cannot
    // determine whether a prior invocation already created the PR for
    // this (head, base), proceeding to provider.createPr() risks opening
    // a second PR every retry. Fail-closed and let the caller retry
    // once the provider is healthy. This mirrors the create-issue
    // handler's PRECHECK_FAILED contract (CodeRabbit #3224631237) so
    // both two-event-split handlers behave consistently. Sentry
    // #14059252/0.
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
    // PR already exists — emit Phase B event and return without re-firing
    // the gh pr create side effect. This append is OUTSIDE the listPrs catch
    // so an append failure surfaces rather than collapsing into "create new PR".
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

  // ─── Side effect: invoke gh pr create ─────────────────────────────────────
  try {
    const result = await provider.createPr({
      title: args.title,
      body: effectiveBody,
      baseBranch: args.base,
      headBranch: args.head,
      draft: args.draft,
      labels: args.labels,
    });

    // ─── Phase B — durable RESULT ────────────────────────────────────────────
    // idempotencyKey ensures retries after a crash between createPr() and this
    // append do not produce duplicate `pr.create.executed` events for the same
    // operationId — the EventStore deduplicates on key-match.
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
