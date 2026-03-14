import type { CommandResult } from '../cli.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Expected shape of the SubagentStop stdin JSON. */
interface SubagentStopInput {
  agent_type: string;      // e.g., 'exarchos-implementer'
  agent_id: string;        // Claude Code agent ID
  exit_reason: string;     // 'complete' | 'error' | 'max_turns'
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Handle the `subagent-stop` CLI command.
 *
 * When a Claude Code subagent (exarchos-implementer or exarchos-fixer) stops,
 * this handler receives the stop event via stdin JSON and returns structured
 * output with the agent's ID and exit reason for the orchestrator to use
 * when updating workflow state.
 *
 * Non-exarchos agents are ignored gracefully (returns a no-op result).
 * Context (featureId, taskId) is extracted from environment variables.
 */
export async function handleSubagentStop(
  stdinData: Record<string, unknown>,
): Promise<CommandResult> {
  const agentType = stdinData.agent_type;

  // Non-exarchos agents are a no-op — return early
  if (typeof agentType !== 'string' || !agentType.startsWith('exarchos-')) {
    return { continue: true };
  }

  // Validate required fields
  const agentId = stdinData.agent_id;
  if (!agentId || typeof agentId !== 'string') {
    return {
      error: {
        code: 'MISSING_AGENT_ID',
        message: 'agent_id is required for exarchos subagent stop events',
      },
    };
  }

  const exitReason = stdinData.exit_reason;
  if (!exitReason || typeof exitReason !== 'string') {
    return {
      error: {
        code: 'MISSING_EXIT_REASON',
        message: 'exit_reason is required for exarchos subagent stop events',
      },
    };
  }

  // Extract context from environment variables
  const featureId = process.env.EXARCHOS_FEATURE_ID;
  const taskId = process.env.EXARCHOS_TASK_ID;

  const result: Record<string, unknown> = {
    agentId,
    exitReason,
  };

  if (featureId) {
    result.featureId = featureId;
  }

  if (taskId) {
    result.taskId = taskId;
  }

  return result;
}
