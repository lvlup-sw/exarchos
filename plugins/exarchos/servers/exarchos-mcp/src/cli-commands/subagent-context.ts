import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TOOL_REGISTRY } from '../registry.js';
import type { CommandResult } from '../cli.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FilteredComposite {
  readonly name: string;
  readonly actions: readonly string[];
}

export interface FilterResult {
  readonly available: readonly FilteredComposite[];
  readonly denied: readonly FilteredComposite[];
}

// ─── Phase + Role Filtering ────────────────────────────────────────────────

/**
 * Filter the TOOL_REGISTRY actions by phase and role.
 *
 * An action is "available" when:
 *   - action.phases.has(currentPhase)
 *   - action.roles.has(role) OR action.roles.has('any')
 *
 * Everything else is "denied".
 */
export function filterToolsForPhaseAndRole(
  phase: string,
  role: string,
): FilterResult {
  const available: FilteredComposite[] = [];
  const denied: FilteredComposite[] = [];

  for (const composite of TOOL_REGISTRY) {
    const availActions: string[] = [];
    const deniedActions: string[] = [];

    for (const action of composite.actions) {
      const phaseMatch = action.phases.has(phase);
      const roleMatch = action.roles.has(role) || action.roles.has('any');

      if (phaseMatch && roleMatch) {
        availActions.push(action.name);
      } else {
        deniedActions.push(action.name);
      }
    }

    if (availActions.length > 0) {
      available.push({ name: composite.name, actions: availActions });
    }
    if (deniedActions.length > 0) {
      denied.push({ name: composite.name, actions: deniedActions });
    }
  }

  return { available, denied };
}

// ─── Output Formatting ─────────────────────────────────────────────────────

/**
 * Format tool guidance as human-readable plain text for SubagentStart injection.
 */
export function formatToolGuidance(
  available: readonly FilteredComposite[],
  denied: readonly FilteredComposite[],
): string {
  if (available.length === 0 && denied.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (available.length > 0) {
    lines.push('Your available Exarchos tools:');
    for (const composite of available) {
      lines.push(`- ${composite.name}: ${composite.actions.join(', ')}`);
    }
  }

  if (denied.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Do NOT call:');
    for (const composite of denied) {
      lines.push(`- ${composite.name}: ${composite.actions.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ─── Active Workflow Discovery ─────────────────────────────────────────────

/**
 * Scan the state directory for the first non-completed workflow and return its phase.
 * Returns null if no active workflow is found.
 *
 * Uses lightweight JSON parsing (no full Zod validation) since we only need the phase field.
 */
export async function findActiveWorkflowPhase(
  stateDir: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return null;
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));

  for (const file of stateFiles) {
    try {
      const raw = await fs.readFile(path.join(stateDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const phase = parsed.phase;

      if (typeof phase === 'string' && phase !== 'completed' && phase !== 'cancelled') {
        return phase;
      }
    } catch {
      // Skip corrupt files
      continue;
    }
  }

  return null;
}

// ─── Command Handler ───────────────────────────────────────────────────────

/**
 * Resolve the workflow state directory from environment or default.
 */
function resolveStateDir(): string {
  const envDir = process.env.WORKFLOW_STATE_DIR;
  if (envDir) return envDir;

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('Cannot determine home directory: HOME and USERPROFILE are both undefined');
  }
  return path.join(home, '.claude', 'workflow-state');
}

/**
 * SubagentStart hook handler.
 *
 * Reads the active workflow's phase, filters tools by phase + teammate role,
 * and outputs plain-text guidance to stdout.
 *
 * Degrades gracefully: outputs nothing if no active workflow exists.
 */
export async function handleSubagentContext(
  _stdinData: Record<string, unknown>,
): Promise<CommandResult> {
  const stateDir = resolveStateDir();
  const phase = await findActiveWorkflowPhase(stateDir);

  if (!phase) {
    // Graceful degradation: no active workflow, output empty guidance
    return { guidance: '' };
  }

  const { available, denied } = filterToolsForPhaseAndRole(phase, 'teammate');
  const guidance = formatToolGuidance(available, denied);

  return { guidance };
}
