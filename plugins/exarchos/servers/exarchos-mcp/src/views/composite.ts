// ─── Composite View Handler ─────────────────────────────────────────────────
//
// Routes `action` to the appropriate view or stack handler, replacing 6
// individual MCP tools with a single `exarchos_view` entry point.

import type { ToolResult } from '../format.js';
import {
  handleViewPipeline,
  handleViewTasks,
  handleViewWorkflowStatus,
  handleViewTeamPerformance,
  handleViewDelegationTimeline,
} from './tools.js';
import { handleStackStatus, handleStackPlace } from '../stack/tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';

/**
 * Composite handler that dispatches to existing view/stack handlers
 * based on the `action` field in args.
 */
export async function handleView(
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const { action, ...rest } = args;

  switch (action) {
    case 'pipeline':
      return handleViewPipeline(
        rest as { limit?: number; offset?: number },
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
          ] as const,
        },
      };
  }
}
