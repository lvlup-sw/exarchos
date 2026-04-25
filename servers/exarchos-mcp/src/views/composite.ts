// ─── Composite View Handler ─────────────────────────────────────────────────
//
// Routes `action` to the appropriate view or stack handler, replacing 6
// individual MCP tools with a single `exarchos_view` entry point.

import { wrap, wrapWithPassthrough, type ToolResult } from '../format.js';
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
  handleViewIdeateReadiness,
  handleViewConvergence,
} from './tools.js';
import { handleStackStatus, handleStackPlace } from '../stack/tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';

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
  const nextActions = nextActionsFromResult(result);
  return wrapWithPassthrough(result, wrap(result.data, meta, perf, nextActions));
}

/**
 * Composite handler that dispatches to existing view/stack handlers
 * based on the `action` field in args.
 */
export async function handleView(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'pipeline':
      return envelopeWrap(
        await handleViewPipeline(
          rest as { limit?: number; offset?: number; includeCompleted?: boolean },
          stateDir,
          eventStore,
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
        await handleViewWorkflowStatus(
          rest as { workflowId?: string },
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
          },
          stateDir,
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
          rest as { workflowId?: string },
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
          },
          stateDir,
          eventStore,
        ),
        startedAt,
      );

    case 'quality_correlation':
      return envelopeWrap(
        await handleViewQualityCorrelation(
          rest as { workflowId?: string },
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

    case 'ideate_readiness':
      return envelopeWrap(
        await handleViewIdeateReadiness(
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
            'ideate_readiness',
            'convergence',
            'describe',
          ] as const,
        },
      };
  }
}
