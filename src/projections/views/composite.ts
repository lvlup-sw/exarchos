// ─── Composite View Handler ─────────────────────────────────────────────────
//
// Routes `action` to the appropriate view or stack handler, replacing 6
// individual MCP tools with a single `exarchos_view` entry point.

import { type ToolResult } from '../../format.js';
import type { NextAction } from '../../next-action.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { handleDescribe } from '../../describe/handler.js';
import { TOOL_REGISTRY } from '../../registry.js';
import { envelopeWrap } from '../../envelope-wrap.js';
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
  handleViewGateReliability,
  getOrCreateMaterializer,
} from './tools.js';
import { handleViewInvariantsEffective } from './effective-catalog.js';
import { handleViewInspect } from './lifecycle/inspect.js';
import { handleViewExport } from './lifecycle/export.js';
import { handleViewWait, type WaitDeps } from './lifecycle/wait.js';
import { handleViewPs } from './lifecycle/ps.js';
import { handleViewWorktrees } from '../../verbs/worktree/handlers.js';
// Only the stack READ is reachable from here. `handleStackPlace` moved to the
// orchestrate router with its action: it appends, and a view module importing
// the writer kept an upward edge that nothing on this surface could declare.
import { handleStackStatus } from '../../verbs/stack/tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';
import type { QualityHintsConfig } from '../../workflow/capabilities/resolver.js';
import { deriveRepoKey } from '../../utils/paths.js';
import { viewLogger } from '../../logger.js';
import {
  assessStreamFreshness,
  publishProjectionFreshness,
  toProjectionDegradedMeta,
  PROJECTION_DEGRADED_META,
} from '../freshness.js';
import {
  guardProjectionDegraded,
  toProjectionDegradedResult,
} from '../degraded-result.js';

const viewActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_view')!.actions;

/**
 * View-composite envelope wrap — the shared `envelopeWrap` (../envelope-wrap.ts)
 * with `mergeHandlerActions` enabled (T039 + T041, DR-7/DR-8; DR-10 dedup).
 *
 * #1262 — view handlers may pre-populate `result.next_actions` with
 * telemetry-derived hints (e.g. the `output_tokens_high` checkpoint hint
 * surfaced by `handleViewTelemetry`). The `mergeHandlerActions` knob prepends
 * those to the HSM-derived verbs so the envelope carries both, rather than the
 * wrap silently dropping the handler source (which the workflow / orchestrate /
 * event-store composites do — their handlers carry no such hints). This is the
 * ONLY per-composite difference; everything else is the shared helper.
 */
function wrapView(result: ToolResult, startedAt: number): ToolResult {
  return envelopeWrap(result, startedAt, { mergeHandlerActions: true });
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
  // liveness arms. `WaitDeps` is the superset (it extends `WorktreeViewDeps`
  // with the generic-`wait` subscription/deadline seams) so one param threads
  // both the worktree ps/wait scope AND the generic wait's phase/status/operation
  // predicates. Production dispatch (`dispatch/core/dispatch.ts`) calls `handleView(args,
  // ctx)` with no third argument, so the real OS-backed defaults are wired; only
  // the named lifecycle tests thread it. Other action arms ignore it. An extra
  // optional parameter keeps `handleView` assignable to `CompositeHandler`.
  deps?: WaitDeps,
): Promise<ToolResult> {
  const result = await dispatchViewAction(args, ctx, deps);
  return stampProjectionFreshness(result, args, ctx);
}

/**
 * EFF-002 read-surface chokepoint / DR-4 detector, publisher AND consumer.
 *
 * Every view answer routes through here. `exarchos_view` is the only surface
 * that holds BOTH halves of the comparison — the durable tail and the live
 * materializer cursors — so it is the surface that detects a disagreement,
 * makes it durable, and clears it again. `exarchos_workflow` and
 * `exarchos_orchestrate` are pure consumers of what this publishes.
 *
 * Order is load-bearing:
 *
 *   1. The action has already run, so the folds have been brought as current as
 *      a re-fold can bring them. Assessing BEFORE the dispatch would report a
 *      staleness the read itself was about to fix, and — because this is also
 *      the recovery surface — would wedge: the one action able to clear the
 *      state would be the one refused by it.
 *   2. Publish the live verdict. Degraded mints (idempotently) a
 *      `projection.degraded` row; freshly-caught-up mints the paired
 *      `projection.recovered`, releasing every consumer blocked on it. This is
 *      the production write path for T-06's durable state.
 *   3. Refuse. A disagreement that survived step 1 is one a re-fold cannot fix
 *      — a fold ahead of a pruned log, or a sibling projection of the same
 *      stream still trailing — so the payload is dropped and the shared typed
 *      degraded result returned in its place (DR-4).
 *
 * `_meta.projectionDegraded` is KEPT alongside the typed result rather than
 * subsumed: it is the pre-existing per-response courtesy, it is forwarded
 * verbatim by `envelopeWrap`, and `workflow/rehydrate.ts` stamps the same key
 * for the case where a contradictory cache was discarded and the answer IS
 * authoritative — a state that must stay expressible as an annotated success.
 * What changed is that `_meta` is no longer the ONLY signal, and no longer
 * rides on a `success: true` carrying the stale payload.
 *
 * Deliberately conservative:
 * - A failed result is returned untouched; the error is the signal.
 * - A stream with no cached folds is fresh — a cold read folds from scratch.
 * - Any fault computing or publishing freshness leaves the response unchanged.
 *   The freshness probe must never be the reason a healthy read fails.
 */
async function stampProjectionFreshness(
  result: ToolResult,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  if (!result.success) return result;
  const streamId = typeof args['workflowId'] === 'string' ? args['workflowId'] : undefined;
  if (streamId === undefined || streamId.length === 0) return result;

  try {
    const materializer = getOrCreateMaterializer(ctx.stateDir);
    const cursors = materializer?.getStreamCursors?.(streamId) ?? [];
    if (cursors.length === 0) {
      // No fold of our own to judge — but another process may have recorded
      // this stream degraded, and serving it as a clean success would be the
      // exact cross-process blind spot DR-4 exists to close.
      return (
        (await guardProjectionDegraded(ctx.eventStore, streamId, {
          tool: 'exarchos_view',
          action: typeof args['action'] === 'string' ? args['action'] : undefined,
          onError: (err) =>
            viewLogger.warn({ streamId, err }, 'durable projection-health read failed'),
        })) ?? result
      );
    }

    const eventTail = await ctx.eventStore.tailSequence(streamId);
    const freshness = assessStreamFreshness(eventTail, cursors);

    // (2) Publish — the production write path for the durable state. Degraded
    // records; recovered releases. Never allowed to fail the read.
    let durable: Awaited<ReturnType<typeof publishProjectionFreshness>>;
    try {
      durable = await publishProjectionFreshness(ctx.eventStore, streamId, freshness);
    } catch (err) {
      viewLogger.warn({ streamId, err }, 'publishing projection-health state failed');
    }

    const meta = toProjectionDegradedMeta(freshness);
    if (meta === undefined) return result;

    viewLogger.warn(
      { streamId, ...meta },
      'projection cursors disagree with the durable event tail; response refused as degraded (EFF-002/DR-4)',
    );

    // (3) Refuse. The stale payload is dropped, not annotated — a caller that
    // branches on `success` must not be able to act on it.
    const degraded =
      durable ??
      // The publish leg failed; the verdict is still true and still ours to
      // report, so synthesize the same shape from the live comparison rather
      // than silently downgrading to a success.
      {
        streamId,
        reason: meta.reason,
        eventTail: meta.eventTail,
        projectionCursor: meta.projectionCursor,
        lag: meta.lag,
        staleViews: meta.staleViews,
        sequence: 0,
        observedAt: new Date().toISOString(),
      };
    const refusal = toProjectionDegradedResult(degraded, {
      tool: 'exarchos_view',
      action: typeof args['action'] === 'string' ? args['action'] : undefined,
    });
    return {
      ...refusal,
      _meta: { ...(result._meta ?? {}), [PROJECTION_DEGRADED_META]: meta },
    };
  } catch {
    return result;
  }
}

/**
 * Composite handler that dispatches to existing view/stack handlers
 * based on the `action` field in args.
 */
async function dispatchViewAction(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WaitDeps,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'pipeline':
      return wrapView(
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
      return wrapView(
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
      return wrapView(
        // #1555 — `asOf` rides through `rest` unchanged; the dispatch core
        // (`handleViewWorkflowStatus`) owns the bounded-fold behavior (INV-2).
        await handleViewWorkflowStatus(
          rest as { workflowId?: string; asOf?: import('../cursor.js').AsOfParam },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'stack_status':
      return wrapView(
        await handleStackStatus(
          rest as { streamId?: string; limit?: number; offset?: number },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'telemetry':
      return wrapView(
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
      return wrapView(
        await handleViewTeamPerformance(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'delegation_timeline':
      return wrapView(
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
      return wrapView(
        await handleViewDelegationReadiness(
          rest as { workflowId?: string; tasks?: readonly string[]; detail?: boolean },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'code_quality':
      return wrapView(
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
      return wrapView(
        await handleViewQualityHints(
          rest as { workflowId?: string; skill?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'eval_results':
      return wrapView(
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
      return wrapView(
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
      return wrapView(
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
      return wrapView(
        await handleViewSessionProvenance(
          rest as { sessionId?: string; workflowId?: string; metric?: string },
          stateDir,
        ),
        startedAt,
      );

    case 'synthesis_readiness':
      return wrapView(
        await handleViewSynthesisReadiness(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'shepherd_status':
      return wrapView(
        await handleViewShepherdStatus(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'provenance':
      return wrapView(
        await handleViewProvenance(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'convergence':
      return wrapView(
        await handleViewConvergence(
          rest as { workflowId?: string },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    // BASE-002 — the gate-reliability read model reaches production through
    // this action. It is diagnostic-only: no admission or transition authority.
    case 'gate_reliability':
      return wrapView(
        await handleViewGateReliability(
          rest as { workflowId?: string; detail?: boolean },
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
      return wrapView(
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
      return wrapView(await handleViewWorktrees(rest, ctx), startedAt);

    case 'ps':
      // DR-3 (Task 007) — scope-parameterized process-plane lister. `scope: 'all'`
      // (default) composes task 005's workflows fold + task 006's operations fold;
      // `scope: 'workflow'` returns the workflows section; `scope: 'worktree'`
      // delegates to the CONSUMED WLM-6 kernel (inFlightMerges / launches /
      // inFlightPrunes + the `probe: true` reclaim/reconcile write path — the sole
      // write path, valid ONLY in worktree scope). `rest`/`deps` thread every
      // field/mode.
      //
      // DR-7 (Task 018) — for launcher-spawned worktree-scope sessions the launch
      // column answers liveness from the `launch.*` event pair ALONE;
      // `withLaunchLivenessAffordance` surfaces that guarantee as an agent-first
      // `next_actions` hint when any launcher session is in flight (pure
      // annotation — keyed on the worktree-scope `launchCount`, a no-op otherwise).
      return wrapView(
        withLaunchLivenessAffordance(await handleViewPs(rest, ctx, deps)),
        startedAt,
      );

    case 'wait':
      // Generic event-driven gate (DR-5/DR-8) — a PURE CONSUMER that appends
      // nothing. Feature-scoped phase/status/operation predicates resolve via a
      // precheck then a DR-1 subscription (Tier-1 wake / Tier-2 floor), with
      // structured WAIT_TIMEOUT/WAIT_FAILED on expiry/failure; the worktree
      // `until: merge|idle` scope delegates to the absorbed WLM-6 kernel. `rest`
      // carries featureId/phase/status/operation/until/integrationRef/timeoutMs.
      return wrapView(await handleViewWait(rest, ctx, deps), startedAt);

    case 'inspect':
      // Worktree-lifecycle single-workflow projection (DR-4). Pure read: folds
      // the feature stream ONCE via the canonical event-store-first
      // `resolveWorkflowState` and projects state / recent events + correlation
      // tuple / artifacts / task progress. Appends nothing on any path — a cold
      // probe of an unknown featureId returns `workflowExists:false` with ZERO
      // events emitted (the CB-2 no-phantom-stream guarantee).
      return wrapView(await handleViewInspect(rest, ctx), startedAt);

    case 'export':
      // Worktree-lifecycle diagnostic bundle (DR-6). Writes a zip
      // (events.jsonl / state.json / metadata.json / artifacts/) to a path
      // OUTSIDE `.exarchos/` and journals the INV-13 export.requested →
      // export.executed pair around the write (storage idempotency key derived
      // from a logical key per INV-8 — a crash-retry completes the SAME intent,
      // a fresh invocation mints a new pair). Cold-probe safe: an unknown
      // featureId returns workflowExists:false, writes NO zip and emits ZERO
      // events. The CLI verb promotion is task-015.
      return wrapView(await handleViewExport(rest, ctx), startedAt);

    case 'describe':
      return wrapView(
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
            'gate_reliability',
            'invariants_effective',
            'worktrees',
            'ps',
            'wait',
            'inspect',
            'export',
            'describe',
          ] as const,
        },
      };
  }
}
