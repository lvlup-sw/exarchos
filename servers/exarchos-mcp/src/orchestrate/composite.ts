// ─── Composite Orchestrate Handler ──────────────────────────────────────────
//
// Routes an `action` field to the appropriate task handler function,
// replacing individual MCP tools with a single `exarchos_orchestrate` tool.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';

// ─── Task Handlers ──────────────────────────────────────────────────────────

import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
} from '../tasks/tools.js';
import { handleReviewTriage } from '../review/tools.js';
import { handlePrepareDelegation } from './prepare-delegation.js';
import { handlePrepareSynthesis } from './prepare-synthesis.js';
import { handleAssessStack } from './assess-stack.js';
import { handleDesignCompleteness } from './design-completeness.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { handleTddCompliance } from './tdd-compliance.js';
import { handlePostMerge } from './post-merge.js';

// ─── Action Router ──────────────────────────────────────────────────────────

type ActionHandler = (args: Record<string, unknown>, stateDir: string) => Promise<ToolResult>;

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  task_claim: handleTaskClaim as ActionHandler,
  task_complete: handleTaskComplete as ActionHandler,
  task_fail: handleTaskFail as ActionHandler,
  review_triage: handleReviewTriage as ActionHandler,
  prepare_delegation: handlePrepareDelegation as ActionHandler,
  prepare_synthesis: handlePrepareSynthesis as ActionHandler,
  assess_stack: handleAssessStack as ActionHandler,
  check_design_completeness: handleDesignCompleteness as ActionHandler,
  check_plan_coverage: handlePlanCoverage as ActionHandler,
  check_tdd_compliance: handleTddCompliance as ActionHandler,
  check_post_merge: handlePostMerge as ActionHandler,
};

// ─── Composite Handler ──────────────────────────────────────────────────────

/**
 * Routes the `action` field from args to the corresponding task handler.
 *
 * The `action` field is consumed by this router and stripped from the args
 * forwarded to the underlying handler.
 */
export async function handleOrchestrate(
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const action = args.action as string | undefined;

  const handler = action ? ACTION_HANDLERS[action] : undefined;
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: `Unknown orchestrate action '${String(action)}'. Valid actions: ${Object.keys(ACTION_HANDLERS).join(', ')}`,
      },
    };
  }

  // Strip the `action` field before forwarding to the underlying handler
  const { action: _action, ...handlerArgs } = args;

  return handler(handlerArgs as Record<string, unknown>, stateDir);
}
