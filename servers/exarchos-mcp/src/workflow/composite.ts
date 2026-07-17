import { handleInit, handleGet, handleTransition, handleReconcileState, handleCheckpoint, handleUpdate } from './tools.js';
import { handleCancel } from './cancel.js';
import { handleCleanup } from './cleanup.js';
import { handleRehydrate } from './rehydrate.js';
import { handleFeedback } from './feedback.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { type ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { envelopeWrap } from '../envelope-wrap.js';
import { deriveRepoKey } from '../utils/paths.js';
import { workflowLogger } from '../logger.js';

const workflowActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!.actions;

// HATEOAS envelope wrapping is the shared `envelopeWrap` (../envelope-wrap.ts).
// Successful workflow results are re-shaped into `Envelope<T>` at the tool
// boundary; `next_actions` is populated whenever the handler's response carries
// `{ phase, workflowType }` (handleInit / handleGet / handleTransition) and
// otherwise defaults to `[]`. Internal callers of the underlying handlers
// (e.g. orchestrate/prune-stale-workflows, orchestrate/finalize-oneshot) still
// see the raw `ToolResult` they depend on. Error responses pass through
// unchanged so structured `error` payloads stay accessible to callers.
//
// The `rehydrate` action alone additionally applies `applyCacheHints` (T051,
// DR-14) via the shared helper's `cacheHintsResolver` knob: rehydrate is the
// only action with a stable serialized prefix worth caching, so cache-control
// semantics stay scoped to that surface. See the call site below.

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
    case 'init': {
      // DR-5: the composite layer owns caller identity — compute the memoized
      // repo key from the serving process's directory (`ctx.cwd` defaults to
      // `process.cwd()` per core/dispatch.ts) and thread it into `handleInit`
      // so `workflow.started` records `repoRoot`. deriveRepoKey collapses the
      // main checkout and every worktree to one key and memoizes, so this costs
      // a map lookup after the first init. This is the production wiring that
      // closes the built-but-unwired gap (a direct handleInit call omits it).
      const repoKey = deriveRepoKey(ctx.cwd ?? process.cwd());
      return envelopeWrap(
        await handleInit(rest as Parameters<typeof handleInit>[0], stateDir, eventStore, repoKey),
        startedAt,
      );
    }
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
      // DR-3: the resolved mutation score-enforcement mode + threshold for the
      // pure `allReviewsPassed` guard, injected as `_mutationEnforcement` /
      // `_mutationThreshold` (HIGH tier only, in tools.ts).
      const mutationEnforcement = ctx.projectConfig?.review.mutationEnforcement;
      const mutationThreshold = ctx.projectConfig?.review.gates['mutation-adequacy']?.params
        ?.threshold as number | undefined;
      // DR-6: the resolved NoCoverage budget for the guard's orthogonal Check 4b
      // axis, injected as `_maxNoCoverage`. Defaults to 0 (zero uncovered changed
      // mutants) when the project sets no
      // `review.gates['mutation-adequacy'].params.maxNoCoverage` — so block mode
      // enforces the strict default without an explicit config line. Same config
      // plumbing as the threshold above (INV-2 — the decision lives in the guard).
      const maxNoCoverageRaw = ctx.projectConfig?.review.gates['mutation-adequacy']?.params
        ?.maxNoCoverage;
      const maxNoCoverage =
        typeof maxNoCoverageRaw === 'number' && Number.isFinite(maxNoCoverageRaw)
          ? maxNoCoverageRaw
          : 0;
      const transitionOptions: Record<string, unknown> = {};
      if (skipPhases?.length) transitionOptions.skipPhases = skipPhases;
      if (requiredReviews?.length) transitionOptions.requiredReviews = requiredReviews;
      if (checkpoint) transitionOptions.checkpoint = checkpoint;
      if (typeof maxPlanRevisions === 'number') transitionOptions.maxPlanRevisions = maxPlanRevisions;
      if (mutationEnforcement !== undefined) transitionOptions.mutationEnforcement = mutationEnforcement;
      if (typeof mutationThreshold === 'number') transitionOptions.mutationThreshold = mutationThreshold;
      // Plumb the budget whenever a review config is resolved (signalled by the
      // enforcement mode being present) — even absent an explicit
      // `params.maxNoCoverage`, so block mode enforces the strict default (0).
      // Gating on `mutationEnforcement !== undefined` mirrors the threshold's
      // config-presence contract and keeps the no-config path passing `undefined`.
      if (mutationEnforcement !== undefined) transitionOptions.maxNoCoverage = maxNoCoverage;
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
      // Rehydrate-only cache-hint wiring (T051, DR-14): pass the resolver so the
      // shared helper applies `_cacheHints` on `anthropic_native_caching`
      // runtimes. An undefined resolver leaves the envelope untouched.
      return envelopeWrap(
        await handleRehydrate(
          rest as unknown as Parameters<typeof handleRehydrate>[0],
          { stateDir, eventStore },
        ),
        startedAt,
        { cacheHintsResolver: ctx.capabilityResolver },
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
