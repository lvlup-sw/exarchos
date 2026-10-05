import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';

/**
 * Returns the session provenance for one `sessionId` or one `workflowId`, never both.
 * The compact default drops the per-file attribution and the file list, and keeps the
 * tool, token, and cost metrics. With `detail: true` it returns the full result.
 */
export async function handleViewSessionProvenance(
  args: {
    sessionId?: string;
    workflowId?: string;
    metric?: string;
    detail?: boolean;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.sessionId && !args.workflowId) {
    return {
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'Either sessionId or workflowId is required',
      },
    };
  }

  if (args.sessionId && args.workflowId) {
    return {
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'Provide sessionId or workflowId, not both',
      },
    };
  }

  const validMetrics = new Set(['cost', 'attribution']);
  const metric = args.metric && validMetrics.has(args.metric)
    ? (args.metric as 'cost' | 'attribution')
    : undefined;

  try {
    const { materializeSessionProvenance } = await import(
      '../../session/session-provenance-projection.js'
    );
    const result = await materializeSessionProvenance(stateDir, {
      sessionId: args.sessionId,
      workflowId: args.workflowId,
      metric,
    });
    if (args.detail) {
      return { success: true, data: result };
    }
    const { fileAttribution: _fileAttribution, files: _files, ...compact } = result;
    return { success: true, data: compact };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'session_provenance' });
  }
}
