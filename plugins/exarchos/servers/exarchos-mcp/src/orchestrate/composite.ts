// ─── Composite Orchestrate Handler ──────────────────────────────────────────
//
// Routes an `action` field to the appropriate team or task handler function,
// replacing 8 individual MCP tools with a single `exarchos_orchestrate` tool.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';

// ─── Team Handlers ──────────────────────────────────────────────────────────

import {
  handleTeamSpawn,
  handleTeamMessage,
  handleTeamBroadcast,
  handleTeamShutdown,
  handleTeamStatus,
} from '../team/tools.js';

// ─── Task Handlers ──────────────────────────────────────────────────────────

import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
} from '../tasks/tools.js';

// ─── Action Router ──────────────────────────────────────────────────────────

type ActionHandler = (args: Record<string, unknown>, stateDir: string) => Promise<ToolResult>;

const TEAM_ACTIONS: Readonly<Record<string, ActionHandler>> = {
  team_spawn: handleTeamSpawn as ActionHandler,
  team_message: handleTeamMessage as ActionHandler,
  team_broadcast: handleTeamBroadcast as ActionHandler,
  team_shutdown: handleTeamShutdown as ActionHandler,
  team_status: handleTeamStatus as ActionHandler,
};

const TASK_ACTIONS: Readonly<Record<string, ActionHandler>> = {
  task_claim: handleTaskClaim as ActionHandler,
  task_complete: handleTaskComplete as ActionHandler,
  task_fail: handleTaskFail as ActionHandler,
};

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  ...TEAM_ACTIONS,
  ...TASK_ACTIONS,
};

// ─── Composite Handler ──────────────────────────────────────────────────────

/**
 * Routes the `action` field from args to the corresponding team or task handler.
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
