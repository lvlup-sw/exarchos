import { handleInit, handleGet, handleTransition, handleReconcileState, handleCheckpoint, handleUpdate } from './tools.js';
import { handleCancel } from './cancel.js';
import { handleCleanup } from './cleanup.js';
import { handleRehydrate } from './rehydrate.js';
import { handleFeedback } from './feedback.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { applyCacheHints, wrap, wrapWithPassthrough, type Envelope, type ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { nextActionsFromResult } from '../next-actions-from-result.js';
import type { CapabilityResolver } from '../capabilities/resolver.js';
import { workflowLogger } from '../logger.js';

const workflowActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!.actions;

/**
 * HATEOAS envelope wrapping for successful tool responses (T036 + T041, DR-7/DR-8).
 *
 * Successful results are re-shaped into `Envelope<T>` at the tool
 * boundary so agents see a stable contract with `next_actions`, `_meta`,
 * and `_perf` on every response. Internal callers of the underlying
 * handlers (e.g. orchestrate/prune-stale-workflows, orchestrate/finalize-
 * oneshot) continue to see the raw `ToolResult` they depend on.
 *
 * `next_actions` is populated by `nextActionsFromResult` whenever the
 * handler's response data contains both `phase` and `workflowType` (the
 * real `handleInit`/`handleGet`/`handleTransition` return both). Otherwise the
 * field defaults to `[]` so the envelope shape is stable — e.g. for
 * `describe`, `cleanup`, and `cancel` actions, or legacy responses that
 * omit `workflowType`.
 *
 * Error responses pass through unchanged so structured `error` payloads
 * (error codes, valid transition targets, suggested fixes) remain
 * accessible to callers for auto-correction flows.
 */
function envelopeWrap(result: ToolResult, startedAt: number): ToolResult {
  if (!result.success) return result;

  const meta = (result._meta ?? {}) as Record<string, unknown>;
  const perf = result._perf ?? { ms: Date.now() - startedAt };
  // Compute once per composite call. `nextActionsFromResult` is a pure
  // lookup over the HSM registry; no I/O.
  const nextActions = nextActionsFromResult(result);
  return wrapWithPassthrough(result, wrap(result.data, meta, perf, nextActions));
}

/**
 * Rehydrate-only envelope wrap (T051, DR-14): identical to `envelopeWrap`
 * but additionally applies `applyCacheHints` so the response carries a
 * `_cacheHints` field on runtimes that report `anthropic_native_caching`.
 *
 * Scoped to the rehydrate dispatch path because rehydrate is the only
 * action with a stable serialized prefix worth caching — other workflow
 * actions either mutate state (init/transition/cancel/cleanup/checkpoint) or
 * return small payloads where cache annotations carry no benefit. The
 * followups doc (T051) explicitly limits the wiring to this surface so
 * the cost-saving feature ships as designed without leaking
 * cache-control semantics into actions where they do not belong.
 */
function envelopeWrapWithCacheHints(
  result: ToolResult,
  startedAt: number,
  resolver: CapabilityResolver | undefined,
): ToolResult {
  if (!result.success) return result;

  const meta = (result._meta ?? {}) as Record<string, unknown>;
  const perf = result._perf ?? { ms: Date.now() - startedAt };
  const nextActions = nextActionsFromResult(result);
  let envelope: Envelope<unknown> = wrap(result.data, meta, perf, nextActions);
  if (resolver !== undefined) {
    envelope = applyCacheHints(envelope, resolver);
  }
  return wrapWithPassthrough(result, envelope);
}

/**
 * Composite handler that routes `action` to the appropriate workflow handler.
 * Replaces individual init/get/transition/cancel tools with a single
 * discriminated-union tool.
 */
export async function handleWorkflow(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'init':
      return envelopeWrap(await handleInit(rest as Parameters<typeof handleInit>[0], stateDir, eventStore), startedAt);
    case 'get':
      return envelopeWrap(await handleGet(rest as Parameters<typeof handleGet>[0], stateDir, eventStore), startedAt);
    case 'transition': {
      // T36/T37/DR-4 — canonical phase-mutation surface. Routes through the
      // shared `applyTransition()` helper in `handleTransition`. v2.11
      // (T5a.1) hard-cut the prior `set({phase})` rerouting path; this is
      // now the single phase-mutation entry point. Honors project-config
      // skipPhases / requiredReviews / checkpoint policy.
      const skipPhases = ctx.projectConfig?.workflow.skipPhases;
      const requiredReviews = ctx.projectConfig?.workflow.requiredReviews;
      const checkpoint = ctx.projectConfig?.checkpoint;
      // DR-1: the resolved plan-revision cap for the pure `revisionsExhausted`
      // guard, injected as `_maxPlanRevisions` (never event-sourced — INV-1).
      const maxPlanRevisions = ctx.projectConfig?.workflow.maxPlanRevisions;
      const transitionOptions: Record<string, unknown> = {};
      if (skipPhases?.length) transitionOptions.skipPhases = skipPhases;
      if (requiredReviews?.length) transitionOptions.requiredReviews = requiredReviews;
      if (checkpoint) transitionOptions.checkpoint = checkpoint;
      if (typeof maxPlanRevisions === 'number') transitionOptions.maxPlanRevisions = maxPlanRevisions;
      return envelopeWrap(
        await handleTransition(
          rest as unknown as Parameters<typeof handleTransition>[0],
          stateDir,
          eventStore,
          Object.keys(transitionOptions).length > 0
            ? transitionOptions as Parameters<typeof handleTransition>[3]
            : undefined,
        ),
        startedAt,
      );
    }
    case 'update': {
      // Wave 0 (#1340, v2.10.0-preview.2): canonical state-mutation
      // surface for non-phase fields. `handleUpdate` performs the
      // phase-in-updates input guard then delegates to `handleSet` so
      // the same event-first / CAS / per-stream-lock machinery serves
      // both the legacy `set` callers (now removed) and the canonical
      // `update` action.
      //
      // Keeping the guard inside `handleUpdate` (in tools.ts) rather
      // than here in the composite keeps the contract local to the
      // function CLI dispatch and direct-import callers reach for —
      // anyone bypassing the composite still hits the guard.
      return envelopeWrap(
        await handleUpdate(
          rest as unknown as Parameters<typeof handleUpdate>[0],
          stateDir,
          eventStore,
        ),
        startedAt,
      );
    }
    case 'cancel':
      return envelopeWrap(await handleCancel(rest as Parameters<typeof handleCancel>[0], stateDir, eventStore), startedAt);
    case 'cleanup':
      return envelopeWrap(await handleCleanup(rest as Parameters<typeof handleCleanup>[0], stateDir, eventStore), startedAt);
    case 'reconcile':
      return envelopeWrap(await handleReconcileState(rest as Parameters<typeof handleReconcileState>[0], stateDir, eventStore), startedAt);
    case 'feedback':
      // #1319 — agent→runtime friction back-channel. Not feature-scoped: the
      // handler appends to the shared `meta/feedback` stream and (best-effort)
      // POSTs upstream when `.exarchos.yml` declares `feedback.upstream`. The
      // local write succeeds without network access (offline-first / INV-15).
      return envelopeWrap(await handleFeedback(rest as Parameters<typeof handleFeedback>[0], stateDir, eventStore), startedAt);
    case 'checkpoint': {
      // #1244 Sentry MEDIUM — load handoffLint.hardFail from .exarchos.yml and
      // thread it to handleCheckpoint. Without this wiring the hard-fail switch
      // was silently ignored in production (the helper code path existed but
      // was never reached because composite stripped the options bag).
      //
      // Sentry HIGH #1244 follow-up: `stateDir` is the global state directory
      // (e.g. `~/.exarchos/state` or wherever the server was bootstrapped),
      // NOT a path inside the user's project. Deriving worktreePath from
      // stateDir would silently miss the project's `.exarchos.yml`.
      // `process.cwd()` is the canonical project entry point (the user
      // invoked Exarchos from their repo root) and `loadExarchosConfig`
      // walks worktree → git-repo-root from there, matching the CLI's own
      // discovery algorithm in yaml-loader.ts.
      const { loadExarchosConfig } = await import('../config/load-exarchos-config.js');
      const worktreePath = process.cwd();
      let checkpointOptions: { handoffLint?: { hardFail: boolean } } | undefined;
      try {
        const result = loadExarchosConfig(worktreePath);
        const hardFail = result?.config.handoffLint?.hardFail;
        if (typeof hardFail === 'boolean') {
          checkpointOptions = { handoffLint: { hardFail } };
        }
      } catch (err) {
        // CodeRabbit MAJOR #1244: do NOT silently fail-open. A config
        // load/validation failure here is operator-visible signal — without
        // the warn line an explicitly-configured `hardFail: true` would
        // silently downgrade to soft-fail with no trail. We still allow
        // checkpoint to proceed (best-effort) but emit a structured warn
        // so the regression is grep-able in production logs.
        workflowLogger.warn(
          {
            stateDir,
            worktreePath,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to load .exarchos.yml for checkpoint handoffLint; defaulting to soft-fail',
        );
      }
      return envelopeWrap(
        await handleCheckpoint(
          rest as Parameters<typeof handleCheckpoint>[0],
          stateDir,
          eventStore,
          checkpointOptions,
        ),
        startedAt,
      );
    }
    case 'rehydrate':
      return envelopeWrapWithCacheHints(
        await handleRehydrate(
          rest as unknown as Parameters<typeof handleRehydrate>[0],
          { stateDir, eventStore },
        ),
        startedAt,
        ctx.capabilityResolver,
      );
    case 'describe':
      return envelopeWrap(
        await handleDescribe(
          rest as { actions?: string[]; topology?: string; playbook?: string; config?: boolean },
          workflowActions,
          { includeStateSchema: true, projectConfig: ctx.projectConfig },
        ),
        startedAt,
      );
    default: {
      // DR-4 (#1259, v2.11): `set` is no longer a valid workflow action.
      // The previous v2.10 rerouting surface (`set({phase})` →
      // `transition`) is hard-cut. Surface `validActions` as a structured
      // field so agents can self-correct without parsing the message
      // string (INV-5a — agent input ergonomics). Derived from the
      // canonical `workflowActions` registry so the list cannot drift when
      // an action is added or renamed.
      const validActions = workflowActions.map((a) => a.name);
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${String(action)}. Valid actions: ${validActions.join(', ')}`,
          validActions,
        },
      };
    }
  }
}
