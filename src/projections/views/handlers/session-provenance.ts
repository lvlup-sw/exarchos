import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';

// ─── View Session Provenance Handler ─────────────────────────────────────────

export async function handleViewSessionProvenance(
  args: {
    sessionId?: string;
    workflowId?: string;
    metric?: string;
    // DR-8 (Task 024) — compact-by-default drops the verbose per-file
    // attribution + file list; `detail: true` restores them.
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
    // DR-8 (Task 024) compact-by-default — drop the verbose per-file
    // attribution + raw file list; the headline metrics (tools / tokens / cost)
    // stay. `detail: true` restores the full provenance result.
    if (args.detail) {
      return { success: true, data: result };
    }
    const { fileAttribution: _fileAttribution, files: _files, ...compact } = result;
    return { success: true, data: compact };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'session_provenance' });
  }
}
