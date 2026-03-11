// ─── Composite View Handler ─────────────────────────────────────────────────
//
// Routes `action` to the appropriate view or stack handler, replacing 6
// individual MCP tools with a single `exarchos_view` entry point.

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
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
 * Composite handler that dispatches to existing view/stack handlers
 * based on the `action` field in args.
 */
export async function handleView(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const { stateDir } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'pipeline':
      return handleViewPipeline(
        rest as { limit?: number; offset?: number; includeCompleted?: boolean },
        stateDir,
      );

    case 'tasks':
      return handleViewTasks(
        rest as {
          workflowId?: string;
          filter?: Record<string, unknown>;
          limit?: number;
          offset?: number;
          fields?: string[];
        },
        stateDir,
      );

    case 'workflow_status':
      return handleViewWorkflowStatus(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'stack_status':
      return handleStackStatus(
        rest as { streamId?: string; limit?: number; offset?: number },
        stateDir,
      );

    case 'stack_place':
      return handleStackPlace(
        rest as {
          streamId: string;
          position: number;
          taskId: string;
          branch?: string;
          prUrl?: string;
        },
        stateDir,
      );

    case 'telemetry':
      return handleViewTelemetry(
        rest as {
          compact?: boolean;
          tool?: string;
          sort?: 'tokens' | 'invocations' | 'duration';
          limit?: number;
        },
        stateDir,
      );

    case 'team_performance':
      return handleViewTeamPerformance(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'delegation_timeline':
      return handleViewDelegationTimeline(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'delegation_readiness':
      return handleViewDelegationReadiness(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'code_quality':
      return handleViewCodeQuality(
        rest as {
          workflowId?: string;
          skill?: string;
          gate?: string;
          limit?: number;
        },
        stateDir,
      );

    case 'quality_hints':
      return handleViewQualityHints(
        rest as { workflowId?: string; skill?: string },
        stateDir,
      );

    case 'eval_results':
      return handleViewEvalResults(
        rest as {
          workflowId?: string;
          skill?: string;
          limit?: number;
        },
        stateDir,
      );

    case 'quality_correlation':
      return handleViewQualityCorrelation(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'quality_attribution':
      return handleViewQualityAttribution(
        rest as {
          workflowId?: string;
          dimension?: string;
          skill?: string;
          timeRange?: { start: string; end: string };
        },
        stateDir,
      );

    case 'session_provenance':
      return handleViewSessionProvenance(
        rest as { sessionId?: string; workflowId?: string; metric?: string },
        stateDir,
      );

    case 'synthesis_readiness':
      return handleViewSynthesisReadiness(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'shepherd_status':
      return handleViewShepherdStatus(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'provenance':
      return handleViewProvenance(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'ideate_readiness':
      return handleViewIdeateReadiness(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'convergence':
      return handleViewConvergence(
        rest as { workflowId?: string },
        stateDir,
      );

    case 'describe':
      return handleDescribe(rest as { actions: string[] }, viewActions);

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
