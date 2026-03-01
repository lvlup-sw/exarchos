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
import { handleStaticAnalysis } from './static-analysis.js';
import { handleSecurityScan } from './security-scan.js';
import { handleContextEconomy } from './context-economy.js';
import { handleOperationalResilience } from './operational-resilience.js';
import { handleWorkflowDeterminism } from './workflow-determinism.js';
import { handleReviewVerdict } from './review-verdict.js';
import { handleCheckConvergence } from './check-convergence.js';
import { handleProvenanceChain } from './provenance-chain.js';
import { handleTaskDecomposition } from './task-decomposition.js';

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
  check_tdd_compliance: handleTddCompliance as unknown as ActionHandler,
  check_post_merge: handlePostMerge as unknown as ActionHandler,
  check_static_analysis: handleStaticAnalysis as unknown as ActionHandler,
  check_security_scan: handleSecurityScan as unknown as ActionHandler,
  check_context_economy: handleContextEconomy as unknown as ActionHandler,
  check_operational_resilience: handleOperationalResilience as unknown as ActionHandler,
  check_workflow_determinism: handleWorkflowDeterminism as unknown as ActionHandler,
  check_review_verdict: handleReviewVerdict as unknown as ActionHandler,
  check_convergence: handleCheckConvergence as unknown as ActionHandler,
  check_provenance_chain: handleProvenanceChain as unknown as ActionHandler,
  check_task_decomposition: handleTaskDecomposition as unknown as ActionHandler,
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
