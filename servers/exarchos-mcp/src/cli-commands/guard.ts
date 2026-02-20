import { TOOL_REGISTRY } from '../registry.js';
import { listStateFiles } from '../workflow/state-store.js';
import { resolveStateDir } from '../workflow/state-store.js';
import type { CommandResult } from '../cli.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MCP_TOOL_PREFIX = 'mcp__exarchos__';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PreToolUseDenyOutput {
  readonly hookEventName: 'PreToolUse';
  readonly permissionDecision: 'deny';
  readonly reason: string;
}

// ─── Tool Name Extraction ───────────────────────────────────────────────────

/**
 * Extract the composite tool name from a full MCP tool name.
 * e.g. "mcp__exarchos__exarchos_workflow" -> "exarchos_workflow"
 * Returns null if the tool name doesn't match the exarchos prefix.
 */
function extractCompositeToolName(mcpToolName: string): string | null {
  if (!mcpToolName.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  return mcpToolName.slice(MCP_TOOL_PREFIX.length);
}

// ─── Registry Lookup ────────────────────────────────────────────────────────

/**
 * Look up valid phases for a given composite tool name and action name.
 * Returns the set of valid phases, or null if the tool/action is not found.
 */
function lookupActionPhases(
  compositeToolName: string,
  actionName: string,
): ReadonlySet<string> | null {
  const composite = TOOL_REGISTRY.find((c) => c.name === compositeToolName);
  if (!composite) return null;

  const action = composite.actions.find((a) => a.name === actionName);
  if (!action) return null;

  return action.phases;
}

// ─── Deny Response Builder ──────────────────────────────────────────────────

function buildDenyResult(actionName: string, currentPhase: string, validPhases: ReadonlySet<string>): CommandResult {
  const validPhaseList = [...validPhases].sort().join(', ');
  const hookSpecificOutput: PreToolUseDenyOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    reason: `Action '${actionName}' is not valid in phase '${currentPhase}'. Valid phases: ${validPhaseList}`,
  };
  return { hookSpecificOutput };
}

// ─── Allow Response ─────────────────────────────────────────────────────────

function buildAllowResult(): CommandResult {
  return {};
}

// ─── Workflow Identifier Extraction ─────────────────────────────────────────

/**
 * Extract the workflow identifier from tool input.
 * Workflow tools use `featureId`, orchestrate tools use `streamId`,
 * event tools use `stream`.
 * Returns null if no identifier is present.
 */
function extractWorkflowId(toolInput: Record<string, unknown>): string | null {
  const id = toolInput.featureId ?? toolInput.streamId ?? toolInput.stream;
  return typeof id === 'string' ? id : null;
}

// ─── Active Workflow Phase ──────────────────────────────────────────────────

const FINAL_PHASES = new Set(['completed', 'cancelled']);

/**
 * Find the current phase of the targeted workflow, or fall back to the
 * most recently updated active workflow.
 *
 * When `targetId` is provided, returns the phase of that specific workflow
 * (or null if it doesn't exist or is in a final phase). This enables
 * per-workflow guard scoping — tools targeting workflow A are checked
 * against A's phase, not an unrelated workflow B.
 *
 * When `targetId` is null, falls back to the most recently updated active
 * workflow for backward compatibility with tools that don't specify a
 * workflow identifier (e.g., orchestrate actions).
 */
async function findActiveWorkflowPhase(
  stateDir: string,
  targetId: string | null,
): Promise<string | null> {
  let stateFiles;
  try {
    stateFiles = await listStateFiles(stateDir);
  } catch {
    // State directory doesn't exist or is unreadable
    return null;
  }

  if (stateFiles.length === 0) {
    return null;
  }

  // Per-workflow scoping: if a target is specified, check only that workflow
  if (targetId !== null) {
    const match = stateFiles.find((sf) => sf.featureId === targetId);
    if (!match) return null;
    if (FINAL_PHASES.has(match.state.phase)) return null;
    return match.state.phase;
  }

  // Fallback: most recently updated active workflow
  const activeWorkflows = stateFiles.filter((sf) => !FINAL_PHASES.has(sf.state.phase));
  if (activeWorkflows.length === 0) {
    return null;
  }

  // Sort by updatedAt descending for deterministic selection across platforms
  const sorted = activeWorkflows.sort((a, b) => {
    const tsA = Date.parse(a.state.updatedAt) || 0;
    const tsB = Date.parse(b.state.updatedAt) || 0;
    return tsB - tsA;
  });

  return sorted[0].state.phase;
}

// ─── Guard Handler ──────────────────────────────────────────────────────────

/**
 * Handle the guard CLI command (PreToolUse hook).
 *
 * Checks if the tool+action combination is valid for the current workflow phase.
 * Returns an empty object to allow, or a deny object with reason.
 *
 * Graceful degradation: allows the call if no active workflow, unknown tool,
 * or unknown action is encountered.
 */
export async function handleGuard(
  stdinData: Record<string, unknown>,
  stateDirOverride?: string,
): Promise<CommandResult> {
  // Extract tool name and action from stdin
  const toolName = stdinData.tool_name;
  if (typeof toolName !== 'string') {
    return buildAllowResult();
  }

  // Extract composite tool name from the MCP prefix
  const compositeToolName = extractCompositeToolName(toolName);
  if (compositeToolName === null) {
    // Not an exarchos MCP tool — allow
    return buildAllowResult();
  }

  // Extract action from tool_input
  const toolInput = stdinData.tool_input;
  if (typeof toolInput !== 'object' || toolInput === null) {
    return buildAllowResult();
  }
  const actionName = (toolInput as Record<string, unknown>).action;
  if (typeof actionName !== 'string') {
    return buildAllowResult();
  }

  // Look up valid phases for this tool+action
  const validPhases = lookupActionPhases(compositeToolName, actionName);
  if (validPhases === null) {
    // Unknown tool or action — allow (graceful degradation)
    return buildAllowResult();
  }

  // Extract workflow identifier for per-workflow scoping
  const targetId = extractWorkflowId(toolInput as Record<string, unknown>);

  // Find the current workflow phase (scoped to target if available)
  const stateDir = stateDirOverride ?? resolveStateDir();
  const currentPhase = await findActiveWorkflowPhase(stateDir, targetId);
  if (currentPhase === null) {
    // No matching active workflow — allow
    return buildAllowResult();
  }

  // Check if current phase is in the valid phases for this action
  if (validPhases.has(currentPhase)) {
    return buildAllowResult();
  }

  // Deny — current phase is not valid for this action
  return buildDenyResult(actionName, currentPhase, validPhases);
}
