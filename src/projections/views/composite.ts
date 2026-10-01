/**
 * The `exarchos_view` composite handler. It routes `action` to a view, stack, or lifecycle handler.
 * A view module imports no writer, so only the stack read comes from `verbs/stack/tools.ts`.
 */

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
import { handleStackStatus } from '../../verbs/stack/tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';
import type { QualityHintsConfig } from '../../workflow/capabilities/resolver.js';
import { deriveRepoKey } from '../../utils/paths.js';
import { viewLogger } from '../../logger.js';
import { publishProjectionFreshness, readProjectionDegradedState } from '../freshness.js';

const viewActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_view')!.actions;

/**
 * Wraps a view result with the shared `envelopeWrap` and `mergeHandlerActions` on. A view handler can set
 * `result.next_actions`, such as the `output_tokens_high` hint of `handleViewTelemetry`. The wrap puts
 * those actions before the HSM-derived verbs, so the envelope carries both.
 */
function wrapView(result: ToolResult, startedAt: number): ToolResult {
  return envelopeWrap(result, startedAt, { mergeHandlerActions: true });
}

/**
 * Appends one `next_actions` hint to a successful `ps` result with a `launchCount` of 1 or more.
 * Only the worktree scope returns `launchCount`. The launch column answers liveness from the
 * `launch.executing_started` and `launch.executed` pair, with no process scan. The hint tells the
 * agent this. The payload stays unchanged.
 *
 * The launch events hold no degradation field, so `ps` cannot report launch degradation from events.
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
 * The `exarchos_view` composite handler. It dispatches `action`, then clears projection health after a
 * successful read. `deps` is a test seam for the `ps` and `wait` arms. Production dispatch omits it, so
 * the real defaults apply. The optional parameter keeps `handleView` assignable to `CompositeHandler`.
 */
export async function handleView(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WaitDeps,
): Promise<ToolResult> {
  const result = await dispatchViewAction(args, ctx, deps);
  return clearProjectionHealth(result, args, ctx);
}

/**
 * Clears the projection health of the `workflowId` stream after a successful read. The view handlers fold
 * to the tail before they answer (`fold-at-tail.ts`), so a successful read proves coverage. A durable
 * `projection.degraded` row on that stream is then stale. Clearing it keeps the health journal a record
 * of live conditions.
 *
 * A failed result returns unchanged. A fault in the recovery publish only logs a warning, so the health
 * journal never fails a healthy read. The held row is read first, so the healthy case skips `tailSequence`.
 */
async function clearProjectionHealth(
  result: ToolResult,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  if (!result.success) return result;
  const streamId = typeof args['workflowId'] === 'string' ? args['workflowId'] : undefined;
  if (streamId === undefined || streamId.length === 0) return result;

  try {
    const held = await readProjectionDegradedState(ctx.eventStore, streamId);
    if (held === undefined) return result;

    const eventTail = await ctx.eventStore.tailSequence(streamId);
    await publishProjectionFreshness(ctx.eventStore, streamId, {
      degraded: false,
      eventTail,
      projectionCursor: eventTail,
      lag: 0,
      staleViews: [],
    });
  } catch (err) {
    viewLogger.warn({ streamId, err }, 'clearing projection-health state failed');
  }
  return result;
}

/**
 * Dispatches `action` to its handler and wraps the result in the envelope. This layer owns caller
 * identity: `pipeline` gets a repo key from `ctx.cwd`, and `deriveRepoKey` maps the main checkout and
 * each worktree to one key. `pipeline` and `telemetry` get `ctx.config` for
 * `qualityHints.outputTokenThreshold`. `gate_reliability` is diagnostic only and has no admission or
 * transition authority. An unknown action gives `UNKNOWN_ACTION`.
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
            repoRoot?: string;
            scope?: 'repo' | 'all';
          },
          stateDir,
          eventStore,
          ctx.config as QualityHintsConfig | undefined,
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
            operationId?: string;
            correlationId?: string;
            causationId?: string;
          },
          stateDir,
          eventStore,
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
      return wrapView(await handleViewWorktrees(rest, ctx), startedAt);

    case 'ps':
      return wrapView(
        withLaunchLivenessAffordance(await handleViewPs(rest, ctx, deps)),
        startedAt,
      );

    case 'wait':
      return wrapView(await handleViewWait(rest, ctx, deps), startedAt);

    case 'inspect':
      return wrapView(await handleViewInspect(rest, ctx), startedAt);

    case 'export':
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
