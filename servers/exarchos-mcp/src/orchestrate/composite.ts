// ─── Composite Orchestrate Handler ──────────────────────────────────────────
//
// Routes an `action` field to the appropriate task handler function,
// replacing individual MCP tools with a single `exarchos_orchestrate` tool.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleDescribe } from '../describe/handler.js';
import { handleRunbook } from '../runbooks/handler.js';
import { TOOL_REGISTRY } from '../registry.js';

const orchestrateActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_orchestrate')!.actions;

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
import { handleCheckEventEmissions } from './check-event-emissions.js';
import { handleRunScript } from './run-script.js';
import { handleAgentSpec } from '../agents/handler.js';

// ─── Action Router ──────────────────────────────────────────────────────────

type ActionHandler = (args: Record<string, unknown>, stateDir: string) => Promise<ToolResult>;

/** Wraps a typed handler as an ActionHandler, narrowing Record<string, unknown> to T. */
function adapt<T>(handler: (args: T, stateDir: string) => Promise<ToolResult>): ActionHandler {
  return (args, stateDir) => handler(args as unknown as T, stateDir);
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  task_claim: adapt(handleTaskClaim),
  task_complete: adapt(handleTaskComplete),
  task_fail: adapt(handleTaskFail),
  review_triage: handleReviewTriage,
  prepare_delegation: adapt(handlePrepareDelegation),
  prepare_synthesis: adapt(handlePrepareSynthesis),
  assess_stack: adapt(handleAssessStack),
  check_design_completeness: adapt(handleDesignCompleteness),
  check_plan_coverage: adapt(handlePlanCoverage),
  check_tdd_compliance: adapt(handleTddCompliance),
  check_post_merge: adapt(handlePostMerge),
  check_static_analysis: adapt(handleStaticAnalysis),
  check_security_scan: adapt(handleSecurityScan),
  check_context_economy: adapt(handleContextEconomy),
  check_operational_resilience: adapt(handleOperationalResilience),
  check_workflow_determinism: adapt(handleWorkflowDeterminism),
  check_review_verdict: adapt(handleReviewVerdict),
  check_convergence: adapt(handleCheckConvergence),
  check_provenance_chain: adapt(handleProvenanceChain),
  check_task_decomposition: adapt(handleTaskDecomposition),
  check_event_emissions: adapt(handleCheckEventEmissions),
  run_script: adapt(handleRunScript),
  agent_spec: adapt(handleAgentSpec),
};

/** Exported for sync test — ensures registry.ts stays in sync with handler keys. */
export const ACTION_HANDLER_KEYS: readonly string[] = Object.keys(ACTION_HANDLERS);

// ─── Composite Handler ──────────────────────────────────────────────────────

/**
 * Routes the `action` field from args to the corresponding task handler.
 *
 * The `action` field is consumed by this router and stripped from the args
 * forwarded to the underlying handler.
 */
export async function handleOrchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const { stateDir } = ctx;
  const { action, ...rest } = args;

  // Handle describe specially — it needs the action list, not stateDir
  if (action === 'describe') {
    if (!Array.isArray(rest.actions) || !rest.actions.every(a => typeof a === 'string')) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'describe requires actions: string[]',
          expectedShape: { actions: ['action_name_1', 'action_name_2'] },
        },
      };
    }
    return handleDescribe(rest as { actions: string[] }, orchestrateActions);
  }

  // Handle runbook specially — it doesn't need stateDir
  if (action === 'runbook') {
    if (rest.phase !== undefined && typeof rest.phase !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'runbook phase must be a string if provided',
        },
      };
    }
    if (rest.id !== undefined && typeof rest.id !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'runbook id must be a string if provided',
        },
      };
    }
    return handleRunbook(rest as { phase?: string; id?: string });
  }

  const handler = typeof action === 'string' ? ACTION_HANDLERS[action] : undefined;
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: `Unknown orchestrate action '${String(action)}'. Valid actions: ${Object.keys(ACTION_HANDLERS).join(', ')}, describe, runbook`,
      },
    };
  }

  return handler(rest as Record<string, unknown>, stateDir);
}
