// ─── Runbook Handler ─────────────────────────────────────────────────────────
//
// Two modes:
// - List mode (no `id`): returns summary of all runbooks, optionally filtered by phase.
// - Detail mode (`id` provided): returns the full resolved runbook with schemas
//   resolved from the registry at serve-time.
// ────────────────────────────────────────────────────────────────────────────

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolResult } from '../format.js';
import { findActionInRegistry } from '../registry.js';
import { ALL_RUNBOOKS } from './definitions.js';
import type { ResolvedRunbookStep } from './types.js';

interface RunbookArgs {
  readonly phase?: string;
  readonly id?: string;
}

/**
 * Handles the `runbook` action on exarchos_orchestrate.
 *
 * List mode: returns `{ id, phase, description, stepCount }` for each runbook.
 * Detail mode: returns a fully resolved runbook with schemas from the registry.
 */
export async function handleRunbook(args: RunbookArgs): Promise<ToolResult> {
  // ─── List mode ────────────────────────────────────────────────────────
  if (!args.id) {
    let runbooks = ALL_RUNBOOKS;
    if (args.phase) {
      runbooks = runbooks.filter(r => r.phase === args.phase);
    }

    return {
      success: true,
      data: runbooks.map(r => ({
        id: r.id,
        phase: r.phase,
        description: r.description,
        stepCount: r.steps.length,
      })),
    };
  }

  // ─── Detail mode ──────────────────────────────────────────────────────
  const runbook = ALL_RUNBOOKS.find(r => r.id === args.id);
  if (!runbook) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_RUNBOOK',
        message: `Unknown runbook id: '${args.id}'`,
        validTargets: ALL_RUNBOOKS.map(r => r.id),
      },
    };
  }

  const resolvedSteps: ResolvedRunbookStep[] = runbook.steps.map((step, index) => {
    const isNative = step.tool.startsWith('native:');

    let schema: unknown = null;
    let description: string | undefined;
    let gate: { readonly blocking: boolean; readonly dimension?: string } | null = null;

    if (!isNative) {
      const action = findActionInRegistry(step.tool, step.action);
      if (action) {
        schema = zodToJsonSchema(action.schema);
        description = action.description;
        gate = action.gate ?? null;
      }
    }

    const agentName = isNative
      ? (step.params as Record<string, unknown> | undefined)?.agent
      : undefined;

    return {
      seq: index + 1,
      tool: step.tool,
      action: step.action,
      onFail: step.onFail,
      ...(step.params !== undefined ? { params: step.params } : {}),
      ...(step.note !== undefined ? { note: step.note } : {}),
      schema,
      description,
      gate,
      ...(typeof agentName === 'string'
        ? {
            platformHint: {
              claudeCode: `Uses native agent definition exarchos-${agentName}`,
              generic: `Call agent_spec("${agentName}") to get system prompt and tool restrictions`,
            },
          }
        : {}),
    };
  });

  return {
    success: true,
    data: {
      id: runbook.id,
      phase: runbook.phase,
      description: runbook.description,
      templateVars: runbook.templateVars,
      autoEmits: runbook.autoEmits,
      steps: resolvedSteps,
    },
  };
}
