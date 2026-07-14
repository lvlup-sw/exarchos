// ─── Composite View Handler ─────────────────────────────────────────────────
//
// Routes `action` to the appropriate view or stack handler, replacing 6
// individual MCP tools with a single `exarchos_view` entry point.

import { wrap, wrapWithPassthrough, type ToolResult } from '../format.js';
import type { NextAction } from '../next-action.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { nextActionsFromResult } from '../next-actions-from-result.js';
import {
  handleViewPipeline,
  handleViewTasks,
  handleViewWorkflowStatus,
  handleViewTeamPerformance,
  handleViewDelegationTimeline,
  handleViewDelegationReadiness,
  handleViewCodeQuality,
  handleViewQualityHints,
  handleViewEvalResults,
  handleViewQualityCorrelation,
  handleViewSessionProvenance,
  handleViewQualityAttribution,
  handleViewSynthesisReadiness,
  handleViewShepherdStatus,
  handleViewProvenance,
  handleViewConvergence,
} from './tools.js';
import { handleViewInvariantsEffective } from './effective-catalog.js';
import { handleViewInspect } from './lifecycle/inspect.js';
import {
  handleViewWorktrees,
  handleViewPs,
  handleViewWait,
  type WorktreeViewDeps,
} from '../orchestrate/worktree/handlers.js';
import { handleStackStatus, handleStackPlace } from '../stack/tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';
import type { QualityHintsConfig } from '../capabilities/resolver.js';
import { deriveRepoKey } from '../utils/paths.js';

const viewActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_view')!.actions;

/**
 * HATEOAS envelope wrapping for successful tool responses (T039 + T041, DR-7/DR-8).
 *
 * Mirrors the workflow composite (T036) treatment: successful results are
 * re-shaped into `Envelope<T>` at the tool boundary so agents see a stable
 * contract with `next_actions`, `_meta`, and `_perf` on every response.
 * Internal callers of the underlying handlers (view materializer, stack
 * handlers, etc.) continue to see the raw `ToolResult` they depend on.
 *
 * `next_actions` is derived by `nextActionsFromResult` — in practice view
 * payloads (pipelines, tasks, telemetry, provenance, etc.) do not carry
 * `{ phase, workflowType }` at the envelope boundary, so this yields `[]`.
 * The call is retained for architectural symmetry with the workflow
 * composite; the function is a pure, cheap lookup.
 *
 * Error responses pass through unchanged so structured `error` payloads
 * (error codes, valid targets, suggested fixes) remain accessible to
 * callers for auto-correction flows.
 */
function envelopeWrap(result: ToolResult, startedAt: number): ToolResult {
  if (!result.success) return result;

  const meta = (result._meta ?? {}) as Record<string, unknown>;
  const perf = result._perf ?? { ms: Date.now() - startedAt };
  // #1262 — handlers may pre-populate `result.next_actions` with telemetry-
  // derived hints (e.g. the `output_tokens_high` checkpoint hint surfaced
  // by `handleViewTelemetry`). Merge those with the HSM-derived verbs
  // from `nextActionsFromResult` so the envelope carries both rather than
  // the wrap silently dropping one source.
  const hsmActions = nextActionsFromResult(result);
  const handlerActions = result.next_actions ?? [];
  const nextActions = [...handlerActions, ...hsmActions];
  return wrapWithPassthrough(result, wrap(result.data, meta, perf, nextActions));
}

/**
 * DR-7 (Task 018) — launcher-session liveness affordance for the `ps` surface.
 *
 * The `ps` launch column answers a launcher-spawned session's liveness from the
 * `launch.executing_started` / `launch.executed` event pair ALONE: an entry is
 * in-flight while the CLAIM has no paired terminal, and the fold clears it the
 * moment the terminal lands — no live process scan is consulted (that is only
 * the opt-in `probe: true` reclaim path). When one or more launcher sessions are
 * in flight, surface that guarantee to the agent as a single `next_actions`
 * hint so the event-sourced liveness is discoverable rather than implicit.
 *
 * Pure annotation: the WLM fold's `launches` / `launchCount` payload is returned
 * untouched; only the `next_actions` channel is appended to. Errors and the
 * probe/no-launch cases pass through unchanged.
 *
 * Known limitation (documented follow-up, out of scope here): injection
 * *degradation* is computed on the launcher lifecycle result at the
 * `launch.executing_started` phase but is NOT yet persisted as a field on the
 * event, so `ps` can answer launch *liveness* from events alone but cannot yet
 * surface *degradation* from events alone.
 */
function withLaunchLivenessAffordance(result: ToolResult): ToolResult {
  if (!result.success) return result;
  const launchCount = (result.data as { launchCount?: number } | undefined)?.launchCount ?? 0;
  if (launchCount < 1) return result;
  const affordance: NextAction = {
    verb: 'ps',
    reason: `${launchCount} launcher session${launchCount === 1 ? '' : 's'} in flight — liveness is answered from launch.* events alone (no process scan); the column clears as each launch.executed terminal folds, so re-running ps refreshes it.`,
  };
  const existing = result.next_actions ?? [];
  return { ...result, next_actions: [...existing, affordance] };
}

/**
 * Composite handler that dispatches to existing view/stack handlers
 * based on the `action` field in args.
 */
export async function handleView(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  // WLM operational core (DR-4) — test-only DI seam for the `ps` / `wait`
  // worktree-liveness arms (fake process-table source / realpath / sleep clock).
  // Production dispatch (`core/dispatch.ts`) calls `handleView(args, ctx)` with
  // no third argument, so the real OS-backed defaults are wired; only the named
  // worktree tests thread it. Other action arms ignore it. An extra optional
  // parameter keeps `handleView` assignable to `CompositeHandler` (2 params).
  deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'pipeline':
      return envelopeWrap(
        await handleViewPipeline(
          rest as {
            limit?: number;
            offset?: number;
            includeCompleted?: boolean;
            detail?: boolean;
            // DR-6 — explicit scope inputs ride through `rest` from the CLI/MCP
            // args; the handler resolves them against the caller key below.
            repoRoot?: string;
            scope?: 'repo' | 'all';
          },
          stateDir,
          eventStore,
          // DR-3 — thread the resolved `.exarchos.yml` so
          // `qualityHints.outputTokenThreshold` drives the measured-size summary
          // (same single-hop cast the `telemetry` arm uses).
          ctx.config as QualityHintsConfig | undefined,
          // DR-6 — the composite layer OWNS caller identity: compute the memoized
          // repo key from the serving process's directory (`ctx.cwd` defaults to
          // `process.cwd()` per core/dispatch.ts) and thread it so the pipeline
          // view scopes to the caller's repo by default. `deriveRepoKey` collapses
          // the main checkout and every worktree to one key and memoizes, so this
          // is a map lookup after the first call. Mirrors `workflow/composite.ts`
          // threading the same key into `handleInit`.
          deriveRepoKey(ctx.cwd ?? process.cwd()),
        ),
        startedAt,
      );

    case 'tasks':
      return envelopeWrap(
        await handleViewTasks(
          rest as {
            workflowId?: string;
            filter?: Record<string, unknown>;
            limit?: number;
            offset?: number;
            fields?: string[];
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'workflow_status':
      return envelopeWrap(
        // #1555 — `asOf` rides through `rest` unchanged; the dispatch core
        // (`handleViewWorkflowStatus`) owns the bounded-fold behavior (INV-2).
        await handleViewWorkflowStatus(
          rest as { workflowId?: string; asOf?: import('../projections/cursor.js').AsOfParam },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'stack_status':
      return envelopeWrap(
        await handleStackStatus(
          rest as { streamId?: string; limit?: number; offset?: number },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'stack_place':
      return envelopeWrap(
        await handleStackPlace(
          rest as {
            streamId: string;
            position: number;
            taskId: string;
            branch?: string;
            prUrl?: string;
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'telemetry':
      return envelopeWrap(
        await handleViewTelemetry(
          rest as {
            compact?: boolean;
            tool?: string;
            sort?: 'tokens' | 'invocations' | 'duration';
            limit?: number;
            // Wave 5 (#1437) — correlation tuple filters scope the
            // telemetry rollup to a single dispatch boundary.
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
          // #1262 — thread the resolved `.exarchos.yml` so
          // `qualityHints.outputTokenThreshold` flows into the hint
          // generator. `ExarchosConfig` already declares a structurally-
          // compatible `qualityHints` slice; the cast is a single hop to
          // `QualityHintsConfig` (no `unknown` indirection needed) so
          // the readonly mismatch surfaces clearly if either type drifts.
          ctx.config as QualityHintsConfig | undefined,
        ),
        startedAt,
      );

    case 'team_performance':
      return envelopeWrap(
        await handleViewTeamPerformance(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'delegation_timeline':
      return envelopeWrap(
        await handleViewDelegationTimeline(
          rest as {
            workflowId?: string;
            // Wave 5 (#1437) — correlation tuple filters scope the
            // projection fold to a single dispatch boundary.
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'delegation_readiness':
      return envelopeWrap(
        await handleViewDelegationReadiness(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'code_quality':
      return envelopeWrap(
        await handleViewCodeQuality(
          rest as {
            workflowId?: string;
            skill?: string;
            gate?: string;
            limit?: number;
            // Wave 5 (#1437) — correlation tuple filters scope the
            // projection fold to a single dispatch boundary.
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'quality_hints':
      return envelopeWrap(
        await handleViewQualityHints(
          rest as { workflowId?: string; skill?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'eval_results':
      return envelopeWrap(
        await handleViewEvalResults(
          rest as {
            workflowId?: string;
            skill?: string;
            limit?: number;
            // Wave 5 (#1437) — correlation tuple filters scope the
            // projection fold to a single dispatch boundary.
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'quality_correlation':
      return envelopeWrap(
        await handleViewQualityCorrelation(
          rest as {
            workflowId?: string;
            // Wave 5 (#1437) — correlation tuple filters scope both
            // underlying projection folds (CQ + ER) to a single dispatch
            // boundary.
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'quality_attribution':
      return envelopeWrap(
        await handleViewQualityAttribution(
          rest as {
            workflowId?: string;
            dimension?: string;
            skill?: string;
            timeRange?: { start: string; end: string };
            // Wave 5 (#1437) — correlation tuple filters scope both
            // underlying projection folds (CQ + ER) to a single dispatch
            // boundary.
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'session_provenance':
      return envelopeWrap(
        await handleViewSessionProvenance(
          rest as { sessionId?: string; workflowId?: string; metric?: string },
          stateDir,
        ),
        startedAt,
      );

    case 'synthesis_readiness':
      return envelopeWrap(
        await handleViewSynthesisReadiness(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'shepherd_status':
      return envelopeWrap(
        await handleViewShepherdStatus(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'provenance':
      return envelopeWrap(
        await handleViewProvenance(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'convergence':
      return envelopeWrap(
        await handleViewConvergence(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'invariants_effective':
      // DR-7 (T-20) — the facade delegates to `resolveEffectiveCatalog`; the
      // `repoRoot` falls back to `ctx.cwd` (then `process.cwd()` inside the
      // handler) so the dev-catalog + `.exarchos.yml` resolve from the active
      // workspace.
      return envelopeWrap(
        await handleViewInvariantsEffective(
          rest as {
            phase: string;
            workflowType: string;
            repoRoot?: string;
            touchedFiles?: string[];
          },
        ),
        startedAt,
      );

    case 'worktrees':
      // WLM foundation (task 008) — read the `worktrees@v1` projection via the
      // WorktreeManager facade. Behavior lives in the shared dispatch core
      // (INV-2); the handler takes the full DispatchContext for `ctx.eventStore`.
      return envelopeWrap(await handleViewWorktrees(rest, ctx), startedAt);

    case 'ps':
      // WLM operational core (DR-4/DR-3) — list the live worktree-layer liveness
      // pairs from the `worktrees@v1` fold (no process scan): in-flight merges,
      // launches, AND prunes (`inFlightPrunes`, DR-3). `probe: true` additionally
      // pulls the DR-5 process probe and emits worktree.released /
      // worktree.orphan_detected (the deferred orphan emitter — the sole write
      // path on this view surface). `rest`/`deps` thread every field/mode.
      //
      // DR-7 (Task 018) — for launcher-spawned sessions the launch column
      // answers liveness from the `launch.*` event pair ALONE;
      // `withLaunchLivenessAffordance` surfaces that guarantee as an agent-first
      // `next_actions` hint when any launcher session is in flight (pure
      // annotation — the WLM fold's `launches` data is untouched).
      return envelopeWrap(
        withLaunchLivenessAffordance(await handleViewPs(rest, ctx, deps)),
        startedAt,
      );

    case 'wait':
      // WLM operational core (DR-4/DR-3) — caller-bounded poll. Default
      // until:'merge' blocks on the serialized merge on `integrationRef` reaching
      // its terminal worktree.merge_executed; until:'idle' blocks until no
      // in-flight prune_worktrees pass remains (prune terminal cleared). Both
      // read-only, structured-timeout-on-expiry, no background timer. `rest`
      // carries `until`/`integrationRef`/`timeoutMs` through unchanged.
      return envelopeWrap(await handleViewWait(rest, ctx, deps), startedAt);

    case 'inspect':
      // Worktree-lifecycle single-workflow projection (DR-4). Pure read: folds
      // the feature stream ONCE via the canonical event-store-first
      // `resolveWorkflowState` and projects state / recent events + correlation
      // tuple / artifacts / task progress. Appends nothing on any path — a cold
      // probe of an unknown featureId returns `workflowExists:false` with ZERO
      // events emitted (the CB-2 no-phantom-stream guarantee).
      return envelopeWrap(await handleViewInspect(rest, ctx), startedAt);

    case 'describe':
      return envelopeWrap(
        await handleDescribe(rest as { actions: string[] }, viewActions),
        startedAt,
      );

    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown view action: ${String(action)}`,
          validTargets: [
            'pipeline',
            'tasks',
            'workflow_status',
            'stack_status',
            'stack_place',
            'telemetry',
            'team_performance',
            'delegation_timeline',
            'delegation_readiness',
            'code_quality',
            'quality_hints',
            'eval_results',
            'quality_correlation',
            'quality_attribution',
            'session_provenance',
            'synthesis_readiness',
            'shepherd_status',
            'provenance',
            'convergence',
            'invariants_effective',
            'worktrees',
            'ps',
            'wait',
            'inspect',
            'describe',
          ] as const,
        },
      };
  }
}
